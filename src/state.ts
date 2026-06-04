import * as fs from 'fs';
import * as path from 'path';
import {
  RpcLimiterState,
  STATE_VERSION,
  DEFAULT_CONFIG,
  DEFAULT_BUCKET,
  BucketState,
} from './types';

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Read state.json. If missing or malformed, return a fresh default state.
 * This is intentional: a corrupted file should not crash all 8 bots.
 *
 * Stale-slot safety: if a bucket's `nextSlotMs` is more than 30s in the
 * future relative to wall clock, we reset it. Protects against clock jumps
 * or bad state from a previous run.
 */
export function readState(stateFile: string, now: number = Date.now()): RpcLimiterState {
  let raw: RpcLimiterState;
  if (!fs.existsSync(stateFile)) {
    raw = freshState();
  } else {
    try {
      const text = fs.readFileSync(stateFile, 'utf8');
      const parsed = JSON.parse(text) as RpcLimiterState;
      raw = migrate(parsed, stateFile);
    } catch (err) {
      // Corrupt or partial write — back it up and start fresh.
      try {
        const backup = `${stateFile}.corrupt.${Date.now()}`;
        fs.copyFileSync(stateFile, backup);
      } catch {
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
export function writeState(stateFile: string, state: RpcLimiterState): Promise<void> {
  const op = writeChain.then(async () => {
    const tmp = `${stateFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    const text = JSON.stringify(state, null, 2);
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, stateFile);
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
export function writeStateSync(stateFile: string, state: RpcLimiterState): void {
  const tmp = `${stateFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const text = JSON.stringify(state, null, 2);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, stateFile);
}

function freshState(): RpcLimiterState {
  return {
    ...DEFAULT_CONFIG,
    buckets: {
      'rpc:shared': { ...DEFAULT_BUCKET },
    },
    exclusive: null,
    lastExclusiveEndedAtMs: null,
    revision: 0,
  };
}

function migrate(state: any, stateFile: string): RpcLimiterState {
  if (!state || typeof state !== 'object') {
    return freshState();
  }
  if (state.version !== STATE_VERSION) {
    // Future: write migration shims. For now, fresh state is the safest fallback.
    return freshState();
  }
  // Defensive defaults for missing fields.
  state.enabled = state.enabled ?? DEFAULT_CONFIG.enabled;
  state.apiKey = state.apiKey ?? DEFAULT_CONFIG.apiKey;
  state.rpcBaseUrl = state.rpcBaseUrl ?? DEFAULT_CONFIG.rpcBaseUrl;
  state.limits = state.limits ?? DEFAULT_CONFIG.limits;
  state.buckets = state.buckets ?? { 'rpc:shared': { ...DEFAULT_BUCKET } };
  state.exclusive = state.exclusive ?? null;
  state.lastExclusiveEndedAtMs = state.lastExclusiveEndedAtMs ?? null;
  state.revision = state.revision ?? 0;
  return state as RpcLimiterState;
}

export function ensureBucket(state: RpcLimiterState, name: string, defaultIntervalMs: number): BucketState {
  if (!state.buckets[name]) {
    state.buckets[name] = { nextSlotMs: 0, intervalMs: defaultIntervalMs };
  }
  return state.buckets[name];
}

export function bumpRevision(state: RpcLimiterState): void {
  state.revision = (state.revision + 1) | 0;
}
