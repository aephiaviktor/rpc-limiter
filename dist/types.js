"use strict";
/**
 * Shared state schema (version 1).
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
exports.STATE_VERSION = 1;
exports.DEFAULT_CONFIG = {
    version: exports.STATE_VERSION,
    enabled: true,
    apiKey: '',
    rpcBaseUrl: 'https://mainnet.helius-rpc.com',
    limits: {
        maxExclusiveMs: 30_000,
        minNormalMsBetweenExclusives: 5_000,
    },
};
exports.DEFAULT_BUCKET = {
    nextSlotMs: 0,
    intervalMs: 1_000,
};
//# sourceMappingURL=types.js.map