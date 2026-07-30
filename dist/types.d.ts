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
export declare const STATE_VERSION = 2;
export type ProviderId = 'main' | 'fallback';
export interface BucketState {
    /** Wall-clock ms of the next reserved slot. */
    nextSlotMs: number;
    /** Fixed interval (ms) between slots. Set from config on first read. */
    intervalMs: number;
}
export interface ExclusiveState {
    ownerId: string;
    label: string;
    acquiredAtMs: number;
    /** Hard cap; auto-expires at this time even if holder is still alive. */
    untilMs: number;
    /** Tie-break: higher wins. Fleet rental passes rentPerDay. */
    priorityHint: number;
}
export interface ProviderState {
    /** Base RPC URL (no api-key). */
    rpcBaseUrl: string;
    /** Helius api-key (or empty for providers that don't need it). */
    apiKey: string;
    /** Recent failure count; cleared on a successful ('ok') outcome. */
    failures: number;
    /** Wall-clock ms until which this provider is in cooldown. `null` = available. */
    cooldownUntilMs: number | null;
}
export interface RpcLimiterState {
    version: 2;
    enabled: boolean;
    providers: Record<ProviderId, ProviderState>;
    /** Round-robin counter for normal-mode provider pick. Bumped under the lock. */
    providersRoundRobinCounter: number;
    buckets: Record<string, BucketState>;
    limits: {
        maxExclusiveMs: number;
        minNormalMsBetweenExclusives: number;
        /** How long a provider stays in cooldown after tripping the failure threshold. */
        cooldownMs: number;
        /** Non-`ok` outcomes before a provider is put into cooldown. */
        failureThreshold: number;
    };
    exclusive: ExclusiveState | null;
    lastExclusiveEndedAtMs: number | null;
    /** Monotonic counter, useful for debugging and ordering. */
    revision: number;
}
export declare const DEFAULT_CONFIG: Omit<RpcLimiterState, 'buckets' | 'exclusive' | 'lastExclusiveEndedAtMs' | 'revision' | 'providersRoundRobinCounter'>;
export declare const DEFAULT_BUCKET: BucketState;
//# sourceMappingURL=types.d.ts.map