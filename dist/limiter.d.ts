import * as lockfile from 'proper-lockfile';
import { RpcLimiterPaths } from './paths';
import { RpcLimiterState, ExclusiveState, STATE_VERSION } from './types';
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
export interface RpcLimiterOptions {
    /** Shared state directory override; otherwise resolves via RPC_LIMITER_HOME / ~/.rpc_limiter. */
    homeOverride?: string;
    /** Override the config fields (e.g. when per-bot override is set). */
    configOverride?: Partial<Pick<RpcLimiterState, 'enabled' | 'apiKey' | 'rpcBaseUrl' | 'limits'>> & {
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
     * (or until deadlineMs, whichever comes first).
     *
     * Steps:
     *   1. Acquire the cross-process lockfile.
     *   2. Read state; if an exclusive is held by a *live* owner, reserve
     *      a grant time after the exclusive ends.
     *   3. Reserve the next slot in the bucket: grantMs = max(now, nextSlotMs).
     *   4. Write back nextSlotMs = grantMs + intervalMs.
     *   5. Release the lockfile.
     *   6. Sleep until grantMs, or fail with DeadlineExceededError.
     */
    wait(bucketName: string, opts?: WaitOptions): Promise<void>;
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
export { RpcLimiterState, ExclusiveState, STATE_VERSION };
export { resolvePaths } from './paths';
//# sourceMappingURL=limiter.d.ts.map