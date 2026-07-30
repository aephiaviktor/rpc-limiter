"use strict";
/**
 * Shared state schema.
 *
 * Version 2 (multi-provider):
 * - Two named providers (`main`, `fallback`) instead of a single top-level
 *   `apiKey`/`rpcBaseUrl`. v1 state is one-way migrated on read: the old
 *   values land in `providers.main`; `providers.fallback` starts empty and
 *   must be configured by the user.
 * - Each provider tracks recent failures and a cooldown timestamp. After
 *   `limits.failureThreshold` non-`ok` outcomes, a provider is marked
 *   `cooldownUntilMs = now + limits.cooldownMs` and skipped by `wait()`.
 * - `providersRoundRobinCounter` is a monotonic counter that drives the
 *   50/50 normal-mode provider pick. Bumped under the lockfile.
 *
 * `buckets` map keyed by bucket name. Each bucket has a fixed intervalMs
 * and a `nextSlotMs` timestamp (the next slot reserved time).
 *
 * `exclusive` is single-slot: only one process can hold it at a time.
 * `ownerId` is `pid:randomNonce` to keep stale-recovery and live-reacquire
 * both correct.
 *
 * `lastExclusiveEndedAtMs` is the wall-clock time the most recent exclusive
 * window ended. Used to enforce `minNormalMsBetweenExclusives` server-side,
 * so a misbehaving fleet-rental loop cannot starve the other bots.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_BUCKET = exports.DEFAULT_CONFIG = exports.STATE_VERSION = void 0;
exports.STATE_VERSION = 2;
exports.DEFAULT_CONFIG = {
    version: exports.STATE_VERSION,
    enabled: true,
    providers: {
        main: {
            rpcBaseUrl: 'https://mainnet.helius-rpc.com',
            apiKey: '',
            failures: 0,
            cooldownUntilMs: null,
        },
        fallback: {
            rpcBaseUrl: '',
            apiKey: '',
            failures: 0,
            cooldownUntilMs: null,
        },
    },
    limits: {
        maxExclusiveMs: 30_000,
        minNormalMsBetweenExclusives: 5_000,
        cooldownMs: 60 * 60 * 1000, // 1h
        failureThreshold: 3,
    },
};
exports.DEFAULT_BUCKET = {
    nextSlotMs: 0,
    intervalMs: 1_000,
};
//# sourceMappingURL=types.js.map