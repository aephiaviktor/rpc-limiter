import * as lockfile from 'proper-lockfile';
import { resolvePaths, RpcLimiterPaths } from './paths';
import {
  readState,
  writeStateSync,
  writeState,
  ensureBucket,
  bumpRevision,
} from './state';
import { RpcLimiterState, ExclusiveState, STATE_VERSION } from './types';
import { ownerId } from './owner';
import { recordRpcMetric, RpcMetricLabels } from './metrics';

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

export type AcquireExclusiveResult =
  | { ok: true; ownerId: string; untilMs: number }
  | { ok: false; reason: 'preempted' | 'min-normal-violated' | 'cooldown'; holder?: ExclusiveState; retryAfterMs?: number };

export interface RpcLimiterOptions {
  /** Shared state directory override; otherwise resolves via RPC_LIMITER_HOME / ~/.rpc_limiter. */
  homeOverride?: string;
  /** Override the config fields (e.g. when per-bot override is set). */
  configOverride?: Partial<Pick<RpcLimiterState, 'enabled' | 'apiKey' | 'rpcBaseUrl' | 'limits'>> & {
    buckets?: Record<string, { intervalMs: number }>;
  };
  /** Override Date.now for tests. */
  now?: () => number;
  /** Override sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override proper-lockfile lock options, mostly for tests. */
  lockOptions?: lockfile.LockOptions;
}

export class RpcLimiter {
  private paths: RpcLimiterPaths;
  private state: RpcLimiterState;
  private selfId: string;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private lockOptions: lockfile.LockOptions;
  private configOverride: RpcLimiterOptions['configOverride'];

  constructor(opts: RpcLimiterOptions = {}) {
    this.paths = resolvePaths(opts.homeOverride);
    this.selfId = ownerId();
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ??
      ((ms: number) =>
        ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
    this.lockOptions = {
      stale: 5_000,
      retries: { retries: 50, minTimeout: 5, maxTimeout: 50, factor: 1.2 },
      realpath: false,
      ...(opts.lockOptions ?? {}),
    };
    this.configOverride = opts.configOverride;

    // Load (or create) state and apply overrides.
    this.state = readState(this.paths.stateFile, this.now());
    this.applyConfigOverride();
  }

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
  async wait(bucketName: string, opts: WaitOptions = {}): Promise<void> {
    if (!this.state.enabled) {
      // Limiter disabled: pass through.
      return;
    }

    const deadline = opts.deadlineMs;
    const maxWait = opts.maxWaitMs;

    while (true) {
      const requestedAtMs = this.now();
      const grantMs = await this.withLock(() => this.reserveSlot(bucketName));
      const now = this.now();
      const sleepMs = grantMs - now;
      const totalWaitMs = Math.max(0, grantMs - requestedAtMs);

      if (sleepMs <= 0) {
        this.recordWaitMetric(bucketName, opts, totalWaitMs, false);
        return;
      }
      if (maxWait !== undefined && sleepMs > maxWait) {
        this.recordWaitMetric(bucketName, opts, totalWaitMs, true);
        throw new WaitTimeoutError(
          `wait('${bucketName}', label='${opts.label ?? ''}') would sleep ${sleepMs}ms > maxWaitMs ${maxWait}ms`
        );
      }
      if (deadline !== undefined) {
        const remaining = deadline - now;
        if (sleepMs > remaining) {
          this.recordWaitMetric(bucketName, opts, totalWaitMs, true);
          throw new DeadlineExceededError(
            `wait('${bucketName}', label='${opts.label ?? ''}') would sleep ${sleepMs}ms past deadlineMs ${deadline}ms`
          );
        }
      }
      await this.sleep(sleepMs);
      this.recordWaitMetric(bucketName, opts, totalWaitMs, false);
      return;
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
  async acquireExclusive(
    label: string,
    maxDurationMs: number,
    opts: AcquireExclusiveOptions = {}
  ): Promise<AcquireExclusiveResult> {
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
            return { ok: false, reason: 'min-normal-violated' as const, retryAfterMs: retryAfter };
          }
        }
      }

      if (existing) {
        // Re-entrant: same owner, refresh untilMs.
        if (existing.ownerId === this.selfId) {
          existing.untilMs = Math.max(existing.untilMs, now + requested);
          existing.label = label;
          existing.priorityHint = priorityHint;
          bumpRevision(this.state);
          return { ok: true, ownerId: this.selfId, untilMs: existing.untilMs };
        }

        // Stale: take over after a small grace.
        const STALE_GRACE_MS = 2_000;
        if (existing.untilMs < now - STALE_GRACE_MS) {
          this.state.exclusive = this.makeExclusive(label, requested, priorityHint, now);
          this.state.lastExclusiveEndedAtMs = null;
          bumpRevision(this.state);
          return { ok: true, ownerId: this.selfId, untilMs: this.state.exclusive.untilMs };
        }

        // Live other owner: resolve.
        const winner = compareExclusive(existing, this.makeExclusive(label, requested, priorityHint, now));
        if (winner !== 'self') {
          return { ok: false, reason: 'preempted' as const, holder: existing };
        }
        // We win by priority; take over.
        this.state.exclusive = this.makeExclusive(label, requested, priorityHint, now);
        this.state.lastExclusiveEndedAtMs = null;
        bumpRevision(this.state);
        return { ok: true, ownerId: this.selfId, untilMs: this.state.exclusive.untilMs };
      }

      // No exclusive held.
      this.state.exclusive = this.makeExclusive(label, requested, priorityHint, now);
      this.state.lastExclusiveEndedAtMs = null;
      bumpRevision(this.state);
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
  async extendExclusive(extraMs: number): Promise<number | null> {
    if (!this.state.enabled) return null;

    return this.withLock(() => {
      const ex = this.state.exclusive;
      if (!ex || ex.ownerId !== this.selfId) {
        return null;
      }
      const cap = this.state.limits.maxExclusiveMs;
      const hardCeiling = ex.acquiredAtMs + cap;
      const newUntil = Math.min(hardCeiling, ex.untilMs + Math.max(0, extraMs));
      ex.untilMs = newUntil;
      bumpRevision(this.state);
      return ex.untilMs;
    });
  }

  /**
   * Release the exclusive if we hold it. Always succeeds (idempotent).
   * Records lastExclusiveEndedAtMs so subsequent acquires respect the
   * min-normal gap.
   */
  async releaseExclusive(): Promise<void> {
    if (!this.state.enabled) return;

    await this.withLock(() => {
      const ex = this.state.exclusive;
      if (!ex) return;
      if (ex.ownerId !== this.selfId) {
        // Not ours; nothing to do.
        return;
      }
      this.state.exclusive = null;
      this.state.lastExclusiveEndedAtMs = this.now();
      bumpRevision(this.state);
    });
  }

  /**
   * Read-only status snapshot. Returns a shallow copy.
   */
  status(): Omit<RpcLimiterState, never> {
    // No lock; this is best-effort and only for CLI / debug.
    return JSON.parse(JSON.stringify(readState(this.paths.stateFile, this.now()))) as RpcLimiterState;
  }

  /** Expose the resolved paths (useful for the CLI). */
  getPaths(): RpcLimiterPaths {
    return this.paths;
  }

  /** Expose the self owner id. */
  getSelfId(): string {
    return this.selfId;
  }

  // -------- internal --------

  private reserveSlot(bucketName: string): number {
    const bucket = ensureBucket(this.state, bucketName, 1_000);
    const now = this.now();
    const ex = this.state.exclusive;

    let floor = now;
    if (ex) {
      // Held by anyone: floor is at least the exclusive's end.
      if (ex.untilMs > floor) {
        floor = ex.untilMs;
      }
    }

    const grant = Math.max(floor, bucket.nextSlotMs);
    bucket.nextSlotMs = grant + bucket.intervalMs;
    bumpRevision(this.state);
    return grant;
  }

  private makeExclusive(
    label: string,
    requestedMs: number,
    priorityHint: number,
    now: number
  ): ExclusiveState {
    return {
      ownerId: this.selfId,
      label,
      acquiredAtMs: now,
      untilMs: now + requestedMs,
      priorityHint,
    };
  }

  private applyConfigOverride(): void {
    if (!this.configOverride) return;
    if (this.configOverride.enabled !== undefined) this.state.enabled = this.configOverride.enabled;
    if (this.configOverride.apiKey !== undefined) this.state.apiKey = this.configOverride.apiKey;
    if (this.configOverride.rpcBaseUrl !== undefined) this.state.rpcBaseUrl = this.configOverride.rpcBaseUrl;
    if (this.configOverride.limits !== undefined) {
      this.state.limits = { ...this.state.limits, ...this.configOverride.limits };
    }
    if (this.configOverride.buckets) {
      for (const [name, def] of Object.entries(this.configOverride.buckets)) {
        const existing = this.state.buckets[name];
        if (existing) {
          existing.intervalMs = def.intervalMs;
        } else {
          this.state.buckets[name] = { nextSlotMs: 0, intervalMs: def.intervalMs };
        }
      }
    }
  }

  private async withLock<T>(fn: () => T): Promise<T> {
    // Ensure lockfile exists; lockfile() will create it if missing.
    if (!require('fs').existsSync(this.paths.lockfile)) {
      require('fs').writeFileSync(this.paths.lockfile, '');
    }
    const release = await lockfile.lock(this.paths.lockfile, this.lockOptions);
    try {
      // Re-read state under lock to get freshest view.
      this.state = readState(this.paths.stateFile, this.now());
      this.applyConfigOverride();
      const result = fn();
      writeStateSync(this.paths.stateFile, this.state);
      return result;
    } finally {
      try {
        await release();
      } catch {
        // best-effort
      }
    }
  }

  private recordWaitMetric(
    bucketName: string,
    opts: WaitOptions,
    waitMs: number,
    rejected: boolean,
  ): void {
    const labels = opts.metrics;
    const method = labels?.method ?? opts.label ?? bucketName;

    void recordRpcMetric(
      this.paths,
      {
        app: labels?.app,
        profile: labels?.profile,
        method,
        bucket: bucketName,
        waitMs,
        rejected,
      },
      this.now(),
      this.lockOptions,
    ).catch(() => {
      // Metrics must never block or fail RPC scheduling.
    });
  }
}

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
function compareExclusive(existing: ExclusiveState, challenger: ExclusiveState): 'existing' | 'self' {
  if (existing.acquiredAtMs < challenger.acquiredAtMs) return 'existing';
  if (existing.acquiredAtMs > challenger.acquiredAtMs) return 'self';
  if (existing.priorityHint > challenger.priorityHint) return 'existing';
  if (existing.priorityHint < challenger.priorityHint) return 'self';
  return 'existing';
}

export class DeadlineExceededError extends Error {
  readonly kind = 'deadline-exceeded';
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineExceededError';
  }
}

export class WaitTimeoutError extends Error {
  readonly kind = 'wait-timeout';
  constructor(message: string) {
    super(message);
    this.name = 'WaitTimeoutError';
  }
}

// Re-export for completeness.
export { RpcLimiterState, ExclusiveState, STATE_VERSION };
export { resolvePaths } from './paths';
