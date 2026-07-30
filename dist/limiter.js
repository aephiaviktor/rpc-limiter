"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePaths = exports.STATE_VERSION = exports.WaitTimeoutError = exports.DeadlineExceededError = exports.RpcLimiter = void 0;
const lockfile = __importStar(require("proper-lockfile"));
const paths_1 = require("./paths");
const state_1 = require("./state");
const types_1 = require("./types");
Object.defineProperty(exports, "STATE_VERSION", { enumerable: true, get: function () { return types_1.STATE_VERSION; } });
const owner_1 = require("./owner");
const metrics_1 = require("./metrics");
const WAIT_REVALIDATE_INTERVAL_MS = 250;
class RpcLimiter {
    paths;
    state;
    selfId;
    now;
    sleep;
    lockOptions;
    configOverride;
    constructor(opts = {}) {
        this.paths = (0, paths_1.resolvePaths)(opts.homeOverride);
        this.selfId = (0, owner_1.ownerId)();
        this.now = opts.now ?? (() => Date.now());
        this.sleep =
            opts.sleep ??
                ((ms) => ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
        this.lockOptions = {
            stale: 5_000,
            retries: { retries: 50, minTimeout: 5, maxTimeout: 50, factor: 1.2 },
            realpath: false,
            ...(opts.lockOptions ?? {}),
        };
        this.configOverride = opts.configOverride;
        // Load (or create) state and apply overrides.
        this.state = (0, state_1.readState)(this.paths.stateFile, this.now());
        this.applyConfigOverride();
    }
    /**
     * Reserve a slot in the named bucket. Sleeps until the slot is granted
     * (or until deadlineMs, whichever comes first). Returns the provider the
     * caller should send the RPC to.
     *
     * Provider selection:
     *   - If another process holds a `fleet:aggressive` exclusive, prefer
     *     `main` so the aggressive race can use `fallback` directly.
     *   - Otherwise round-robin 50/50 between main and fallback.
     *   - In either case, a provider in cooldown (cooldownUntilMs > now) is
     *     skipped; if both are in cooldown, the call still returns a provider
     *     (caller will see a clear network error).
     *
     * Steps:
     *   1. Acquire the cross-process lockfile.
     *   2. Read state; if an exclusive is held by a *live* owner, reserve
     *      a grant time after the exclusive ends.
     *   3. Pick a provider.
     *   4. Reserve the next slot in the bucket: grantMs = max(now, nextSlotMs).
     *   5. Write back nextSlotMs = grantMs + intervalMs.
     *   6. Release the lockfile.
     *   7. Sleep until grantMs, or fail with DeadlineExceededError.
     */
    async wait(bucketName, opts = {}) {
        if (!this.state.enabled) {
            // Limiter disabled: pass through. Default to 'main' for the caller's URL.
            return { provider: 'main' };
        }
        const deadline = opts.deadlineMs;
        const maxWait = opts.maxWaitMs;
        while (true) {
            const requestedAtMs = this.now();
            const decision = await this.withLock(() => {
                const ex = this.state.exclusive;
                // Only flip routing to main while the fleet race is actually live.
                // An expired exclusive (untilMs <= now) means the race is over and
                // we should go back to round-robin.
                const preferMain = !!(ex && ex.ownerId !== this.selfId && ex.label === 'fleet:aggressive' && ex.untilMs > this.now());
                const provider = this.pickProvider(preferMain);
                const grantMs = this.reserveSlot(bucketName);
                return { grantMs, provider };
            });
            const grantMs = decision.grantMs;
            const provider = decision.provider;
            const now = this.now();
            const sleepMs = grantMs - now;
            const totalWaitMs = Math.max(0, grantMs - requestedAtMs);
            if (sleepMs <= 0) {
                this.recordWaitMetric(bucketName, opts, totalWaitMs, false, provider);
                return { provider };
            }
            if (maxWait !== undefined && sleepMs > maxWait) {
                this.recordWaitMetric(bucketName, opts, totalWaitMs, true, provider);
                throw new WaitTimeoutError(`wait('${bucketName}', label='${opts.label ?? ''}') would sleep ${sleepMs}ms > maxWaitMs ${maxWait}ms`);
            }
            if (deadline !== undefined) {
                const remaining = deadline - now;
                if (sleepMs > remaining) {
                    this.recordWaitMetric(bucketName, opts, totalWaitMs, true, provider);
                    throw new DeadlineExceededError(`wait('${bucketName}', label='${opts.label ?? ''}') would sleep ${sleepMs}ms past deadlineMs ${deadline}ms`);
                }
            }
            let remainingSleepMs = sleepMs;
            let requeue = false;
            while (remainingSleepMs > 0) {
                const chunkMs = Math.min(remainingSleepMs, WAIT_REVALIDATE_INTERVAL_MS);
                await this.sleep(chunkMs);
                remainingSleepMs = grantMs - this.now();
                if (await this.shouldRequeueReservedSlot(requestedAtMs)) {
                    requeue = true;
                    break;
                }
            }
            if (requeue) {
                continue;
            }
            this.recordWaitMetric(bucketName, opts, totalWaitMs, false, provider);
            return { provider };
        }
    }
    /**
     * Try to acquire the exclusive window. Loser gets a `preempted` result
     * and is expected to abort the cycle (no queue, no retry inside the limiter).
     *
     * Resolution order:
     *   1. No exclusive held → win.
     *   2. Held by self (re-entrant) → refresh untilMs and return ok.
     *   3. Held by another live owner:
     *      - earlier acquiredAtMs wins
     *      - tie → higher priorityHint wins
     *      - final tie → lex order of ownerId
     *      - if we lose → return preempted.
     *   4. Held by a dead owner (untilMs well past) → take over.
     */
    async acquireExclusive(label, maxDurationMs, opts = {}) {
        if (!this.state.enabled) {
            return { ok: true, ownerId: this.selfId, untilMs: this.now() + maxDurationMs };
        }
        const cap = this.state.limits.maxExclusiveMs;
        const requested = Math.max(0, Math.min(maxDurationMs, cap));
        const priorityHint = opts.priorityHint ?? 0;
        return this.withLock(() => {
            const now = this.now();
            const existing = this.state.exclusive;
            // Enforce minNormalMsBetweenExclusives for *new* exclusive acquires only.
            if (!existing) {
                const lastEnd = this.state.lastExclusiveEndedAtMs;
                if (lastEnd !== null) {
                    const gap = now - lastEnd;
                    if (gap < this.state.limits.minNormalMsBetweenExclusives) {
                        const retryAfter = this.state.limits.minNormalMsBetweenExclusives - gap;
                        return { ok: false, reason: 'min-normal-violated', retryAfterMs: retryAfter };
                    }
                }
            }
            if (existing) {
                // Re-entrant: same owner, refresh untilMs.
                if (existing.ownerId === this.selfId) {
                    existing.untilMs = Math.max(existing.untilMs, now + requested);
                    existing.label = label;
                    existing.priorityHint = priorityHint;
                    this.cancelQueuedSlots(now);
                    (0, state_1.bumpRevision)(this.state);
                    return { ok: true, ownerId: this.selfId, untilMs: existing.untilMs };
                }
                // Stale: take over after a small grace.
                const STALE_GRACE_MS = 2_000;
                if (existing.untilMs < now - STALE_GRACE_MS) {
                    this.state.exclusive = this.makeExclusive(label, requested, priorityHint, now);
                    this.state.lastExclusiveEndedAtMs = null;
                    this.cancelQueuedSlots(now);
                    (0, state_1.bumpRevision)(this.state);
                    return { ok: true, ownerId: this.selfId, untilMs: this.state.exclusive.untilMs };
                }
                // Live other owner: resolve.
                const winner = compareExclusive(existing, this.makeExclusive(label, requested, priorityHint, now));
                if (winner !== 'self') {
                    return { ok: false, reason: 'preempted', holder: existing };
                }
                // We win by priority; take over.
                this.state.exclusive = this.makeExclusive(label, requested, priorityHint, now);
                this.state.lastExclusiveEndedAtMs = null;
                this.cancelQueuedSlots(now);
                (0, state_1.bumpRevision)(this.state);
                return { ok: true, ownerId: this.selfId, untilMs: this.state.exclusive.untilMs };
            }
            // No exclusive held.
            this.state.exclusive = this.makeExclusive(label, requested, priorityHint, now);
            this.state.lastExclusiveEndedAtMs = null;
            this.cancelQueuedSlots(now);
            (0, state_1.bumpRevision)(this.state);
            return { ok: true, ownerId: this.selfId, untilMs: this.state.exclusive.untilMs };
        });
    }
    /**
     * Bump the exclusive's untilMs by extraMs. Capped at state.limits.maxExclusiveMs
     * past the original acquiredAtMs. Returns the new untilMs.
     *
     * If we no longer own the exclusive (e.g. another process took it over
     * after we lost priority), returns null.
     */
    async extendExclusive(extraMs) {
        if (!this.state.enabled)
            return null;
        return this.withLock(() => {
            const ex = this.state.exclusive;
            if (!ex || ex.ownerId !== this.selfId) {
                return null;
            }
            const cap = this.state.limits.maxExclusiveMs;
            const hardCeiling = ex.acquiredAtMs + cap;
            const newUntil = Math.min(hardCeiling, ex.untilMs + Math.max(0, extraMs));
            ex.untilMs = newUntil;
            (0, state_1.bumpRevision)(this.state);
            return ex.untilMs;
        });
    }
    /**
     * Release the exclusive if we hold it. Always succeeds (idempotent).
     * Records lastExclusiveEndedAtMs so subsequent acquires respect the
     * min-normal gap.
     */
    async releaseExclusive() {
        if (!this.state.enabled)
            return;
        await this.withLock(() => {
            const ex = this.state.exclusive;
            if (!ex)
                return;
            if (ex.ownerId !== this.selfId) {
                // Not ours; nothing to do.
                return;
            }
            this.state.exclusive = null;
            this.state.lastExclusiveEndedAtMs = this.now();
            (0, state_1.bumpRevision)(this.state);
        });
    }
    /**
     * Report the outcome of a request made to a specific provider. The limiter
     * tracks a sliding failure count; on `limits.failureThreshold` non-`ok`
     * outcomes the provider is put into cooldown for `limits.cooldownMs`.
     *
     * This is how bots signal "this account just 429'd" → the limiter routes
     * the next `wait()` to the other provider.
     */
    async recordProviderOutcome(provider, outcome) {
        if (!this.state.enabled)
            return;
        await this.withLock(() => {
            const p = this.state.providers[provider];
            if (!p)
                return;
            if (outcome === 'ok') {
                p.failures = 0;
                p.cooldownUntilMs = null;
            }
            else {
                p.failures = (p.failures + 1) | 0;
                if (p.failures >= this.state.limits.failureThreshold) {
                    p.cooldownUntilMs = this.now() + this.state.limits.cooldownMs;
                    p.failures = 0; // reset; cooldown takes over until expiry
                }
            }
            (0, state_1.bumpRevision)(this.state);
        });
    }
    /**
     * Pick a provider for the next `wait()`. Honors cooldown (a provider in
     * cooldown is never picked unless the other is also unavailable). If
     * `preferMain` is true and main is available, main wins regardless of
     * the round-robin counter. Otherwise round-robins 50/50.
     *
     * Must be called under the lockfile.
     */
    pickProvider(preferMain) {
        const now = this.now();
        const main = this.state.providers.main;
        const fallback = this.state.providers.fallback;
        const isAvailable = (p) => Boolean(p.rpcBaseUrl) && (p.cooldownUntilMs === null || p.cooldownUntilMs <= now);
        const mainAvail = isAvailable(main);
        const fallbackAvail = isAvailable(fallback);
        if (preferMain) {
            if (mainAvail)
                return 'main';
            if (fallbackAvail)
                return 'fallback';
            return 'main';
        }
        if (mainAvail && fallbackAvail) {
            const pick = this.state.providersRoundRobinCounter % 2 === 0 ? 'main' : 'fallback';
            this.state.providersRoundRobinCounter = (this.state.providersRoundRobinCounter + 1) | 0;
            return pick;
        }
        if (mainAvail)
            return 'main';
        if (fallbackAvail)
            return 'fallback';
        return 'main';
    }
    /**
     * Get the full RPC URL (with api-key) for a provider. Empty string if
     * the provider has no base URL configured.
     */
    getProviderUrl(provider) {
        return buildProviderUrl(this.state.providers[provider]);
    }
    /**
     * Get full RPC URLs for both providers in one call.
     */
    getProviderUrls() {
        return {
            main: buildProviderUrl(this.state.providers.main),
            fallback: buildProviderUrl(this.state.providers.fallback),
        };
    }
    /**
     * Read-only status snapshot. Returns a shallow copy.
     */
    status() {
        // No lock; this is best-effort and only for CLI / debug.
        return JSON.parse(JSON.stringify((0, state_1.readState)(this.paths.stateFile, this.now())));
    }
    /** Expose the resolved paths (useful for the CLI). */
    getPaths() {
        return this.paths;
    }
    /** Expose the self owner id. */
    getSelfId() {
        return this.selfId;
    }
    // -------- internal --------
    reserveSlot(bucketName) {
        const bucket = (0, state_1.ensureBucket)(this.state, bucketName, 1_000);
        const now = this.now();
        const ex = this.state.exclusive;
        let floor = now;
        if (ex && ex.ownerId !== this.selfId) {
            // Held by another process: floor is at least the exclusive's end.
            if (ex.untilMs > floor) {
                floor = ex.untilMs;
            }
        }
        const grant = Math.max(floor, bucket.nextSlotMs);
        bucket.nextSlotMs = grant + bucket.intervalMs;
        (0, state_1.bumpRevision)(this.state);
        return grant;
    }
    async shouldRequeueReservedSlot(requestedAtMs) {
        return this.withLock(() => {
            const ex = this.state.exclusive;
            if (ex && ex.ownerId !== this.selfId && ex.acquiredAtMs >= requestedAtMs) {
                return true;
            }
            const lastExclusiveEndedAtMs = this.state.lastExclusiveEndedAtMs;
            return lastExclusiveEndedAtMs !== null && lastExclusiveEndedAtMs >= requestedAtMs;
        });
    }
    cancelQueuedSlots(now) {
        for (const bucket of Object.values(this.state.buckets)) {
            if (bucket.nextSlotMs > now) {
                bucket.nextSlotMs = now;
            }
        }
    }
    makeExclusive(label, requestedMs, priorityHint, now) {
        return {
            ownerId: this.selfId,
            label,
            acquiredAtMs: now,
            untilMs: now + requestedMs,
            priorityHint,
        };
    }
    applyConfigOverride() {
        if (!this.configOverride)
            return;
        if (this.configOverride.enabled !== undefined)
            this.state.enabled = this.configOverride.enabled;
        if (this.configOverride.limits !== undefined) {
            this.state.limits = { ...this.state.limits, ...this.configOverride.limits };
        }
        if (this.configOverride.providers) {
            for (const id of ['main', 'fallback']) {
                const override = this.configOverride.providers[id];
                if (!override)
                    continue;
                if (override.rpcBaseUrl !== undefined)
                    this.state.providers[id].rpcBaseUrl = override.rpcBaseUrl;
                if (override.apiKey !== undefined)
                    this.state.providers[id].apiKey = override.apiKey;
            }
        }
        if (this.configOverride.buckets) {
            for (const [name, def] of Object.entries(this.configOverride.buckets)) {
                const existing = this.state.buckets[name];
                if (existing) {
                    existing.intervalMs = def.intervalMs;
                }
                else {
                    this.state.buckets[name] = { nextSlotMs: 0, intervalMs: def.intervalMs };
                }
            }
        }
    }
    async withLock(fn) {
        // Ensure lockfile exists; lockfile() will create it if missing.
        if (!require('fs').existsSync(this.paths.lockfile)) {
            require('fs').writeFileSync(this.paths.lockfile, '');
        }
        const release = await lockfile.lock(this.paths.lockfile, this.lockOptions);
        try {
            // Re-read state under lock to get freshest view.
            this.state = (0, state_1.readState)(this.paths.stateFile, this.now());
            this.applyConfigOverride();
            const result = fn();
            (0, state_1.writeStateSync)(this.paths.stateFile, this.state);
            return result;
        }
        finally {
            try {
                await release();
            }
            catch {
                // best-effort
            }
        }
    }
    recordWaitMetric(bucketName, opts, waitMs, rejected, provider) {
        const labels = opts.metrics;
        const method = labels?.method ?? opts.label ?? bucketName;
        void (0, metrics_1.recordRpcMetric)(this.paths, {
            app: labels?.app,
            profile: labels?.profile,
            method,
            bucket: bucketName,
            provider,
            waitMs,
            rejected,
        }, this.now(), this.lockOptions).catch(() => {
            // Metrics must never block or fail RPC scheduling.
        });
    }
}
exports.RpcLimiter = RpcLimiter;
/**
 * Compare two exclusives. Returns 'existing' if the existing holder wins,
 * 'self' if the new request wins.
 *
 * Rules:
 *   - earlier acquiredAtMs wins
 *   - tie → higher priorityHint wins
 *   - complete tie → existing holder wins (sticky / live-holder default).
 *     This is intentional: a new process must not kick out a live holder
 *     when nothing has changed, even on a hash-tie. To force a takeover
 *     after a priority change, the new requester must use a higher
 *     priorityHint.
 */
function compareExclusive(existing, challenger) {
    if (existing.acquiredAtMs < challenger.acquiredAtMs)
        return 'existing';
    if (existing.acquiredAtMs > challenger.acquiredAtMs)
        return 'self';
    if (existing.priorityHint > challenger.priorityHint)
        return 'existing';
    if (existing.priorityHint < challenger.priorityHint)
        return 'self';
    return 'existing';
}
/**
 * Build a full RPC URL from a ProviderState (base + api-key query param).
 * Returns empty string when the provider has no base URL.
 */
function buildProviderUrl(p) {
    if (!p.rpcBaseUrl)
        return '';
    if (!p.apiKey)
        return p.rpcBaseUrl;
    try {
        const url = new URL(p.rpcBaseUrl);
        url.searchParams.set('api-key', p.apiKey);
        return url.toString();
    }
    catch {
        const separator = p.rpcBaseUrl.includes('?') ? '&' : '?';
        return `${p.rpcBaseUrl}${separator}api-key=${encodeURIComponent(p.apiKey)}`;
    }
}
class DeadlineExceededError extends Error {
    kind = 'deadline-exceeded';
    constructor(message) {
        super(message);
        this.name = 'DeadlineExceededError';
    }
}
exports.DeadlineExceededError = DeadlineExceededError;
class WaitTimeoutError extends Error {
    kind = 'wait-timeout';
    constructor(message) {
        super(message);
        this.name = 'WaitTimeoutError';
    }
}
exports.WaitTimeoutError = WaitTimeoutError;
var paths_2 = require("./paths");
Object.defineProperty(exports, "resolvePaths", { enumerable: true, get: function () { return paths_2.resolvePaths; } });
//# sourceMappingURL=limiter.js.map