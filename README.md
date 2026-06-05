# rpc_limiter

Cross-process RPC rate limiter + exclusive-window scheduler for Solana bots
that share a single Helius API key.

## Why

8 bots (GM Market Bot, SA Crew Bot, 3× LM Market Bot, 3× Fleet Rental Bot) all
hit the same Helius key. Throttling started when their combined RPS exceeded
the per-key budget. This library is a tiny cross-process scheduler that:

- Reserves 1 RPS (configurable) of normal RPC traffic across all 8 processes.
- Lets fleet rental bots claim a hard 4-second exclusive window before
  aggressive transactions, so no other bot's RPC request lands in the middle.

## Install

```bash
npm install rpc_limiter
# or for dev: npm link
```

## Configure

State lives in `~/.rpc_limiter/state.json` (override via `RPC_LIMITER_HOME`).

Initialize via the CLI:

```bash
rpc-limiter set apiKey=61b4b51d-... \
             rpcBaseUrl=https://mainnet.helius-rpc.com \
             buckets.rpc:shared.intervalMs=1000 \
             limits.maxExclusiveMs=30000 \
             limits.minNormalMsBetweenExclusives=5000
```

Or by hand: create `~/.rpc_limiter/state.json` with:

```json
{
  "version": 1,
  "enabled": true,
  "apiKey": "61b4b51d-...",
  "rpcBaseUrl": "https://mainnet.helius-rpc.com",
  "buckets": { "rpc:shared": { "nextSlotMs": 0, "intervalMs": 1000 } },
  "limits": { "maxExclusiveMs": 30000, "minNormalMsBetweenExclusives": 5000 },
  "exclusive": null,
  "lastExclusiveEndedAtMs": null,
  "revision": 0
}
```

## Use in a bot

```ts
import { RpcLimiter } from 'rpc_limiter';

const limiter = new RpcLimiter({
  configOverride: settings.useRpcLimiter
    ? { /* optional per-bot override */ }
    : { enabled: false },
});

// Before every RPC:
await limiter.wait('rpc:shared', {
  label: 'getMultipleAccounts',
  metrics: {
    app: 'GM Market Bot',
    profile: 'default',
    method: 'getMultipleAccounts',
  },
  deadlineMs: 5000, // abort if slot can't be reserved in time
});
const res = await fetch(rpcUrl, { /* ... */ });
```

## Fleet rental exclusive pattern

```ts
const result = await limiter.acquireExclusive(
  'fleet:aggressive',
  settings.aggressivePhaseWindowMs, // 4000ms typical, comes from bot settings
  { priorityHint: settings.rentPerDay } // higher wins on tie
);

if (!result.ok) {
  log.warn(`preempted by ${result.holder?.ownerId} label=${result.holder?.label}`);
  return; // skip this cycle
}

try {
  // aggressive phase logic
  if (needsMore) {
    await limiter.extendExclusive(remainingBudgetMs);
  }
} finally {
  await limiter.releaseExclusive();
}
```

## Preemption rules

When two processes race for the exclusive, the winner is decided by:

1. **Earlier `acquiredAtMs` wins.** The first process to call `acquireExclusive`
   gets the lock. Other contenders get `{ ok: false, reason: 'preempted' }`
   and must abort their cycle.
2. **Tie → higher `priorityHint` wins.** Fleet rental passes `rentPerDay` so
   a higher-rent bot can take over a lower-rent bot that's already mid-cycle.
3. **Complete tie → existing holder is sticky.** Live holder wins on a
   complete tie (same `acquiredAtMs`, same `priorityHint`).

`minNormalMsBetweenExclusives` (default 5s) is enforced server-side to
prevent a misbehaving fleet-rental loop from starving the other 7 bots.

## CLI

```bash
rpc-limiter status         # full state.json
rpc-limiter dump           # status + bucket summary + exclusive info
rpc-limiter metrics        # last 24h vs previous 7-day average
rpc-limiter metrics --json # machine-readable comparison report
rpc-limiter set k=v ...    # dotted-key=value pairs
rpc-limiter reset          # restore defaults
rpc-limiter path           # print resolved paths
```

## How it works

- `~/.rpc_limiter/rpc.lock` — `proper-lockfile` lockfile, 5s stale timeout.
- `~/.rpc_limiter/state.json` — atomic writes via tmp+rename, version 1 schema.
- `~/.rpc_limiter/metrics.lock` — separate lock for metrics writes.
- `~/.rpc_limiter/metrics.json` — rolling per-method/per-source counters.

Per-call flow:

1. Acquire lock.
2. Read state.
3. If an exclusive is held by a *live* owner, reserve a grant time
   after `exclusive.untilMs`. Otherwise reserve at `max(now, nextSlotMs)`.
4. Write back `nextSlotMs = grantMs + intervalMs`.
5. Release lock.
6. Sleep until `grantMs` (or fail with `DeadlineExceededError`).

The scheduler lock is held only for the few milliseconds of state read/write.
The sleep happens outside the lock, so 8 bots can hold reserved slots
in flight simultaneously.

## Metrics

`wait()` accepts optional structured metrics labels:

```ts
await limiter.wait('rpc:shared', {
  label: 'Connection.getParsedTokenAccountsByOwner()',
  metrics: {
    app: 'LM Market Bot',
    profile: 'MUD',
    method: 'getParsedTokenAccountsByOwner',
  },
});
```

The limiter normalizes common Solana/Helius methods, so
`getParsedTokenAccountsByOwner` and `getTokenAccountsByOwner` both roll up as
`GET_TOKEN_ACCOUNTS_BY_OWNER`; `sendRawTransaction` rolls up as
`SEND_TRANSACTION`.

Metrics are stored separately from scheduler state and use tiered retention:

- minute buckets: 48 hours
- hour buckets: 30 days
- day buckets: 180 days

Use `rpc-limiter metrics` to compare the last 24h against the average day over
the previous seven UTC days, including the largest source deltas by app/profile.

## Per-bot settings

Each bot has its own `useRpcLimiter` checkbox (default false, rollout safety)
and an optional `rpcLimiterOverrides` object for per-bot deviation.

- Off → bot uses its own API key + URL, no limiter. Today.
- On with no overrides → bot reads the shared config.
- On with overrides → per-bot fields override shared.

## Telemetry hooks

Log every `wait()` that slept > 100ms, every `preempted`, and every
exclusive acquire/release. That gives you the data to tune
`intervalMs` and `minNormalMsBetweenExclusives` later.

## Tests

```bash
npm install
npm run build
npm test
```

23 tests: 20 unit (vitest) + 3 multi-process integration (real forked Node children).
