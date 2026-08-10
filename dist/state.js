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
exports.isTransientRenameError = void 0;
exports.readState = readState;
exports.writeState = writeState;
exports.writeStateSync = writeStateSync;
exports.ensureBucket = ensureBucket;
exports.bumpRevision = bumpRevision;
const fs = __importStar(require("fs"));
const atomic_write_1 = require("./atomic-write");
const types_1 = require("./types");
let writeChain = Promise.resolve();
var atomic_write_2 = require("./atomic-write");
Object.defineProperty(exports, "isTransientRenameError", { enumerable: true, get: function () { return atomic_write_2.isTransientRenameError; } });
/**
 * Read state.json. If missing or malformed, return a fresh default state.
 * This is intentional: a corrupted file should not crash all 8 bots.
 *
 * Stale-slot safety: if a bucket's `nextSlotMs` is more than 30s in the
 * future relative to wall clock, we reset it. Protects against clock jumps
 * or bad state from a previous run.
 */
function readState(stateFile, now = Date.now()) {
    let raw;
    if (!fs.existsSync(stateFile)) {
        raw = freshState();
    }
    else {
        try {
            const text = fs.readFileSync(stateFile, 'utf8');
            const parsed = JSON.parse(text);
            raw = migrate(parsed, stateFile);
        }
        catch (err) {
            // Corrupt or partial write — back it up and start fresh.
            try {
                const backup = `${stateFile}.corrupt.${Date.now()}`;
                fs.copyFileSync(stateFile, backup);
            }
            catch {
                // best-effort
            }
            raw = freshState();
        }
    }
    // Stale-slot safety: clamp obviously-bad future timestamps.
    const STALE_FUTURE_MS = 30_000;
    for (const bucket of Object.values(raw.buckets)) {
        if (bucket.nextSlotMs > now + STALE_FUTURE_MS) {
            bucket.nextSlotMs = 0;
        }
    }
    if (raw.exclusive && raw.exclusive.untilMs < now - 60_000) {
        // 60s past the hard cap = definitely stale.
        raw.exclusive = null;
    }
    return raw;
}
/**
 * Atomic write: serialize through a chain so concurrent writers don't
 * interleave. Each write goes to a tmp file then is renamed.
 */
function writeState(stateFile, state) {
    const op = writeChain.then(async () => {
        const tmp = `${stateFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
        const text = JSON.stringify(state, null, 2);
        try {
            (0, atomic_write_1.cleanupStaleTempFilesSync)(stateFile);
            await fs.promises.writeFile(tmp, text, 'utf8');
            await (0, atomic_write_1.renameWithRetry)(tmp, stateFile);
        }
        finally {
            await (0, atomic_write_1.removeTempFile)(tmp);
        }
    });
    writeChain = op.catch(() => undefined);
    return op;
}
/**
 * Synchronous write for hot-path updates where the caller already holds
 * the lockfile and we want to avoid the async rename hop.
 *
 * IMPORTANT: caller must hold the lockfile. Otherwise races.
 */
function writeStateSync(stateFile, state) {
    const text = JSON.stringify(state, null, 2);
    (0, atomic_write_1.cleanupStaleTempFilesSync)(stateFile);
    (0, atomic_write_1.atomicWriteFileSync)(stateFile, text);
}
function freshState() {
    return {
        ...types_1.DEFAULT_CONFIG,
        providers: {
            main: { ...types_1.DEFAULT_CONFIG.providers.main },
            fallback: { ...types_1.DEFAULT_CONFIG.providers.fallback },
        },
        providersRoundRobinCounter: 0,
        buckets: {
            'rpc:shared': { ...types_1.DEFAULT_BUCKET },
        },
        exclusive: null,
        lastExclusiveEndedAtMs: null,
        revision: 0,
    };
}
function migrate(state, stateFile) {
    if (!state || typeof state !== 'object') {
        return freshState();
    }
    // v1 → v2: copy top-level apiKey + rpcBaseUrl into providers.main.
    // The old fields are dropped; v2 reads only providers[*].
    if (state.version === 1 || state.version === undefined) {
        const oldApiKey = typeof state.apiKey === 'string' ? state.apiKey : '';
        const oldRpcBaseUrl = typeof state.rpcBaseUrl === 'string' && state.rpcBaseUrl
            ? state.rpcBaseUrl
            : types_1.DEFAULT_CONFIG.providers.main.rpcBaseUrl;
        return {
            version: types_1.STATE_VERSION,
            enabled: state.enabled ?? types_1.DEFAULT_CONFIG.enabled,
            providers: {
                main: {
                    rpcBaseUrl: oldRpcBaseUrl,
                    apiKey: oldApiKey,
                    failures: 0,
                    cooldownUntilMs: null,
                },
                fallback: { ...types_1.DEFAULT_CONFIG.providers.fallback },
            },
            providersRoundRobinCounter: 0,
            buckets: state.buckets ?? { 'rpc:shared': { ...types_1.DEFAULT_BUCKET } },
            limits: {
                maxExclusiveMs: state.limits?.maxExclusiveMs ?? types_1.DEFAULT_CONFIG.limits.maxExclusiveMs,
                minNormalMsBetweenExclusives: state.limits?.minNormalMsBetweenExclusives ?? types_1.DEFAULT_CONFIG.limits.minNormalMsBetweenExclusives,
                cooldownMs: types_1.DEFAULT_CONFIG.limits.cooldownMs,
                failureThreshold: types_1.DEFAULT_CONFIG.limits.failureThreshold,
            },
            exclusive: state.exclusive ?? null,
            lastExclusiveEndedAtMs: state.lastExclusiveEndedAtMs ?? null,
            revision: state.revision ?? 0,
        };
    }
    if (state.version !== types_1.STATE_VERSION) {
        // Unknown future version — start fresh.
        return freshState();
    }
    // v2 defensive defaults for missing fields.
    state.enabled = state.enabled ?? types_1.DEFAULT_CONFIG.enabled;
    state.providers = state.providers ?? {
        main: { ...types_1.DEFAULT_CONFIG.providers.main },
        fallback: { ...types_1.DEFAULT_CONFIG.providers.fallback },
    };
    state.providers.main = state.providers.main ?? { ...types_1.DEFAULT_CONFIG.providers.main };
    state.providers.fallback = state.providers.fallback ?? { ...types_1.DEFAULT_CONFIG.providers.fallback };
    for (const id of ['main', 'fallback']) {
        const p = state.providers[id];
        p.rpcBaseUrl = p.rpcBaseUrl ?? '';
        p.apiKey = p.apiKey ?? '';
        p.failures = p.failures ?? 0;
        p.cooldownUntilMs = p.cooldownUntilMs ?? null;
    }
    state.providersRoundRobinCounter = state.providersRoundRobinCounter ?? 0;
    state.limits = state.limits ?? { ...types_1.DEFAULT_CONFIG.limits };
    state.limits.maxExclusiveMs = state.limits.maxExclusiveMs ?? types_1.DEFAULT_CONFIG.limits.maxExclusiveMs;
    state.limits.minNormalMsBetweenExclusives =
        state.limits.minNormalMsBetweenExclusives ?? types_1.DEFAULT_CONFIG.limits.minNormalMsBetweenExclusives;
    state.limits.cooldownMs = state.limits.cooldownMs ?? types_1.DEFAULT_CONFIG.limits.cooldownMs;
    state.limits.failureThreshold = state.limits.failureThreshold ?? types_1.DEFAULT_CONFIG.limits.failureThreshold;
    state.buckets = state.buckets ?? { 'rpc:shared': { ...types_1.DEFAULT_BUCKET } };
    state.exclusive = state.exclusive ?? null;
    state.lastExclusiveEndedAtMs = state.lastExclusiveEndedAtMs ?? null;
    state.revision = state.revision ?? 0;
    return state;
}
function ensureBucket(state, name, defaultIntervalMs) {
    if (!state.buckets[name]) {
        state.buckets[name] = { nextSlotMs: 0, intervalMs: defaultIntervalMs };
    }
    return state.buckets[name];
}
function bumpRevision(state) {
    state.revision = (state.revision + 1) | 0;
}
//# sourceMappingURL=state.js.map