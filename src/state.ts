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
    providers: {
      main: { ...DEFAULT_CONFIG.providers.main },
      fallback: { ...DEFAULT_CONFIG.providers.fallback },
    },
    providersRoundRobinCounter: 0,
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

  // v1 → v2: copy top-level apiKey + rpcBaseUrl into providers.main.
  // The old fields are dropped; v2 reads only providers[*].
  if (state.version === 1 || state.version === undefined) {
    const oldApiKey = typeof state.apiKey === 'string' ? state.apiKey : '';
    const oldRpcBaseUrl =
      typeof state.rpcBaseUrl === 'string' && state.rpcBaseUrl
        ? state.rpcBaseUrl
        : DEFAULT_CONFIG.providers.main.rpcBaseUrl;
    return {
      version: STATE_VERSION,
      enabled: state.enabled ?? DEFAULT_CONFIG.enabled,
      providers: {
        main: {
          rpcBaseUrl: oldRpcBaseUrl,
          apiKey: oldApiKey,
          failures: 0,
          cooldownUntilMs: null,
        },
        fallback: { ...DEFAULT_CONFIG.providers.fallback },
      },
      providersRoundRobinCounter: 0,
      buckets: state.buckets ?? { 'rpc:shared': { ...DEFAULT_BUCKET } },
      limits: {
        maxExclusiveMs: state.limits?.maxExclusiveMs ?? DEFAULT_CONFIG.limits.maxExclusiveMs,
        minNormalMsBetweenExclusives:
          state.limits?.minNormalMsBetweenExclusives ?? DEFAULT_CONFIG.limits.minNormalMsBetweenExclusives,
        cooldownMs: DEFAULT_CONFIG.limits.cooldownMs,
        failureThreshold: DEFAULT_CONFIG.limits.failureThreshold,
      },
      exclusive: state.exclusive ?? null,
      lastExclusiveEndedAtMs: state.lastExclusiveEndedAtMs ?? null,
      revision: state.revision ?? 0,
    };
  }

  if (state.version !== STATE_VERSION) {
    // Unknown future version — start fresh.
    return freshState();
  }

  // v2 defensive defaults for missing fields.
  state.enabled = state.enabled ?? DEFAULT_CONFIG.enabled;
  state.providers = state.providers ?? {
    main: { ...DEFAULT_CONFIG.providers.main },
    fallback: { ...DEFAULT_CONFIG.providers.fallback },
  };
  state.providers.main = state.providers.main ?? { ...DEFAULT_CONFIG.providers.main };
  state.providers.fallback = state.providers.fallback ?? { ...DEFAULT_CONFIG.providers.fallback };
  for (const id of ['main', 'fallback'] as const) {
    const p = state.providers[id];
    p.rpcBaseUrl = p.rpcBaseUrl ?? '';
    p.apiKey = p.apiKey ?? '';
    p.failures = p.failures ?? 0;
    p.cooldownUntilMs = p.cooldownUntilMs ?? null;
  }
  state.providersRoundRobinCounter = state.providersRoundRobinCounter ?? 0;
  state.limits = state.limits ?? { ...DEFAULT_CONFIG.limits };
  state.limits.maxExclusiveMs = state.limits.maxExclusiveMs ?? DEFAULT_CONFIG.limits.maxExclusiveMs;
  state.limits.minNormalMsBetweenExclusives =
    state.limits.minNormalMsBetweenExclusives ?? DEFAULT_CONFIG.limits.minNormalMsBetweenExclusives;
  state.limits.cooldownMs = state.limits.cooldownMs ?? DEFAULT_CONFIG.limits.cooldownMs;
  state.limits.failureThreshold = state.limits.failureThreshold ?? DEFAULT_CONFIG.limits.failureThreshold;
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
