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

export const STATE_VERSION = 1;

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

export interface RpcLimiterState {
  version: 1;
  enabled: boolean;
  apiKey: string;
  rpcBaseUrl: string;
  buckets: Record<string, BucketState>;
  limits: {
    maxExclusiveMs: number;
    minNormalMsBetweenExclusives: number;
  };
  exclusive: ExclusiveState | null;
  lastExclusiveEndedAtMs: number | null;
  /** Monotonic counter, useful for debugging and ordering. */
  revision: number;
}

export const DEFAULT_CONFIG: Omit<RpcLimiterState, 'buckets' | 'exclusive' | 'lastExclusiveEndedAtMs' | 'revision'> = {
  version: STATE_VERSION,
  enabled: true,
  apiKey: '',
  rpcBaseUrl: 'https://mainnet.helius-rpc.com',
  limits: {
    maxExclusiveMs: 30_000,
    minNormalMsBetweenExclusives: 5_000,
  },
};

export const DEFAULT_BUCKET: BucketState = {
  nextSlotMs: 0,
  intervalMs: 1_000,
};
