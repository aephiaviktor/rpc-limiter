import * as lockfile from 'proper-lockfile';
import { RpcLimiterPaths } from './paths';
import { RpcLimiterState, ExclusiveState, STATE_VERSION, ProviderId, ProviderState } from './types';
import { RpcMetricLabels } from './metrics';
export interface WaitOptions {
    /** Opaque label for logging/debug, e.g. 'getMultipleAccounts'. */
    label?: string;
    /** Structured labels for shared metrics. */
    metrics?: RpcMetricLabels;
    /**
     * If set, the wait rejects with DeadlineExceededError if a slot cannot be
     * reserved before this wall-clock time. The bot should set this to the
     * call's own timeout, so a slow limiter cannot make the RPC call double-timeout.
     */
    deadlineMs?: number;
    /**
     * If set, sleep no more than this many ms past the reserved grant time.
     * Useful for "give up gracefully" semantics on very long waits.
     */
    maxWaitMs?: number;
}
export interface AcquireExclusiveOptions {
    /** Tie-break: higher wins. Fleet rental passes rentPerDay. */
    priorityHint?: number;
}
export type AcquireExclusiveResult = {
    ok: true;
    ownerId: string;
    untilMs: number;
} | {
    ok: false;
    reason: 'preempted' | 'min-normal-violated' | 'cooldown';
    holder?: ExclusiveState;
    retryAfterMs?: number;
};
/**
 * Provider that the limiter routed this `wait()` to. The bot should send
 * the corresponding RPC to `getProviderUrls()[result.provider]`.
 */
export interface WaitResult {
    provider: ProviderId;
}
export interface RpcLimiterOptions {
    /** Shared state directory override; otherwise resolves via RPC_LIMITER_HOME / ~/.rpc_limiter. */
    homeOverride?: string;
    /** Override the config fields (e.g. when per-bot override is set). */
    configOverride?: Partial<Pick<RpcLimiterState, 'enabled' | 'limits'>> & {
        providers?: Partial<Record<ProviderId, {
            rpcBaseUrl?: string;
            apiKey?: string;
        }>>;
        buckets?: Record<string, {
            intervalMs: number;
        }>;
    };
    /** Override Date.now for tests. */
    now?: () => number;
    /** Override sleep for tests. */
    sleep?: (ms: number) => Promise<void>;
    /** Override proper-lockfile lock options, mostly for tests. */
    lockOptions?: lockfile.LockOptions;
}
export declare class RpcLimiter {
    private paths;
    private state;
    private selfId;
    private now;
    private sleep;
    private lockOptions;
    private configOverride;
    constructor(opts?: RpcLimiterOptions);
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
    wait(bucketName: string, opts?: WaitOptions): Promise<WaitResult>;
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
    acquireExclusive(label: string, maxDurationMs: number, opts?: AcquireExclusiveOptions): Promise<AcquireExclusiveResult>;
    /**
     * Bump the exclusive's untilMs by extraMs. Capped at state.limits.maxExclusiveMs
     * past the original acquiredAtMs. Returns the new untilMs.
     *
     * If we no longer own the exclusive (e.g. another process took it over
     * after we lost priority), returns null.
     */
    extendExclusive(extraMs: number): Promise<number | null>;
    /**
     * Release the exclusive if we hold it. Always succeeds (idempotent).
     * Records lastExclusiveEndedAtMs so subsequent acquires respect the
     * min-normal gap.
     */
    releaseExclusive(): Promise<void>;
    /**
     * Report the outcome of a request made to a specific provider. The limiter
     * tracks a sliding failure count; on `limits.failureThreshold` non-`ok`
     * outcomes the provider is put into cooldown for `limits.cooldownMs`.
     *
     * This is how bots signal "this account just 429'd" → the limiter routes
     * the next `wait()` to the other provider.
     */
    recordProviderOutcome(provider: ProviderId, outcome: 'ok' | 'rate_limited' | 'error'): Promise<void>;
    /**
     * Pick a provider for the next `wait()`. Honors cooldown (a provider in
     * cooldown is never picked unless the other is also unavailable). If
     * `preferMain` is true and main is available, main wins regardless of
     * the round-robin counter. Otherwise round-robins 50/50.
     *
     * Must be called under the lockfile.
     */
    private pickProvider;
    /**
     * Get the full RPC URL (with api-key) for a provider. Empty string if
     * the provider has no base URL configured.
     */
    getProviderUrl(provider: ProviderId): string;
    /**
     * Get full RPC URLs for both providers in one call.
     */
    getProviderUrls(): Record<ProviderId, string>;
    /**
     * Read-only status snapshot. Returns a shallow copy.
     */
    status(): Omit<RpcLimiterState, never>;
    /** Expose the resolved paths (useful for the CLI). */
    getPaths(): RpcLimiterPaths;
    /** Expose the self owner id. */
    getSelfId(): string;
    private reserveSlot;
    private shouldRequeueReservedSlot;
    private cancelQueuedSlots;
    private makeExclusive;
    private applyConfigOverride;
    private withLock;
    private recordWaitMetric;
}
export declare class DeadlineExceededError extends Error {
    readonly kind = "deadline-exceeded";
    constructor(message: string);
}
export declare class WaitTimeoutError extends Error {
    readonly kind = "wait-timeout";
    constructor(message: string);
}
export { RpcLimiterState, ExclusiveState, STATE_VERSION, ProviderId, ProviderState };
export { resolvePaths } from './paths';
//# sourceMappingURL=limiter.d.ts.map