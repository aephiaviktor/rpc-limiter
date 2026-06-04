import { RpcLimiterState, BucketState } from './types';
/**
 * Read state.json. If missing or malformed, return a fresh default state.
 * This is intentional: a corrupted file should not crash all 8 bots.
 *
 * Stale-slot safety: if a bucket's `nextSlotMs` is more than 30s in the
 * future relative to wall clock, we reset it. Protects against clock jumps
 * or bad state from a previous run.
 */
export declare function readState(stateFile: string, now?: number): RpcLimiterState;
/**
 * Atomic write: serialize through a chain so concurrent writers don't
 * interleave. Each write goes to a tmp file then is renamed.
 */
export declare function writeState(stateFile: string, state: RpcLimiterState): Promise<void>;
/**
 * Synchronous write for hot-path updates where the caller already holds
 * the lockfile and we want to avoid the async rename hop.
 *
 * IMPORTANT: caller must hold the lockfile. Otherwise races.
 */
export declare function writeStateSync(stateFile: string, state: RpcLimiterState): void;
export declare function ensureBucket(state: RpcLimiterState, name: string, defaultIntervalMs: number): BucketState;
export declare function bumpRevision(state: RpcLimiterState): void;
//# sourceMappingURL=state.d.ts.map