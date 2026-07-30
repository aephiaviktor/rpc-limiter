#!/usr/bin/env node
import * as fs from 'fs';
import { resolvePaths } from './paths';
import { RpcLimiterState, DEFAULT_CONFIG, DEFAULT_BUCKET, STATE_VERSION } from './types';
import { buildMetricsComparison, formatMetricsComparison, readMetrics } from './metrics';

const HELP = `rpc-limiter — cross-process RPC rate limiter for shared Helius keys

Usage:
  rpc-limiter status
  rpc-limiter dump
  rpc-limiter set <key>=<value> [<key>=<value> ...]
  rpc-limiter reset
  rpc-limiter path
  rpc-limiter metrics [--json] [--limit=<n>]

Keys for 'set':
  enabled=true|false
  providers.main.rpcBaseUrl=<url>
  providers.main.apiKey=<value>
  providers.fallback.rpcBaseUrl=<url>
  providers.fallback.apiKey=<value>
  buckets.rpc:shared.intervalMs=<ms>
  limits.maxExclusiveMs=<ms>
  limits.minNormalMsBetweenExclusives=<ms>
  limits.cooldownMs=<ms>
  limits.failureThreshold=<n>

Env:
  RPC_LIMITER_HOME  Override shared state directory (default: ~/.rpc_limiter)

Examples:
  rpc-limiter set providers.main.apiKey=*** providers.main.rpcBaseUrl=https://mainnet.helius-rpc.com
  rpc-limiter set providers.fallback.apiKey=*** providers.fallback.rpcBaseUrl=https://mainnet.helius-rpc.com
  rpc-limiter set buckets.rpc:shared.intervalMs=200
  rpc-limiter status
  rpc-limiter metrics
`;

function readStateFile(file: string): RpcLimiterState {
  if (!fs.existsSync(file)) {
    return {
      ...DEFAULT_CONFIG,
      providers: {
        main: { ...DEFAULT_CONFIG.providers.main },
        fallback: { ...DEFAULT_CONFIG.providers.fallback },
      },
      providersRoundRobinCounter: 0,
      buckets: { 'rpc:shared': { ...DEFAULT_BUCKET } },
      exclusive: null,
      lastExclusiveEndedAtMs: null,
      revision: 0,
    };
  }
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text) as RpcLimiterState;
}

function writeStateFile(file: string, state: RpcLimiterState): void {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function setDeep(obj: any, dottedKey: string, value: string): void {
  const parts = dottedKey.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cursor[k] !== 'object' || cursor[k] === null) {
      cursor[k] = {};
    }
    cursor = cursor[k];
  }
  const last = parts[parts.length - 1];
  // Coerce numbers
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    cursor[last] = Number(value);
  } else if (value === 'true' || value === 'false') {
    cursor[last] = value === 'true';
  } else {
    cursor[last] = value;
  }
}

function getDeep(obj: any, dottedKey: string): any {
  return dottedKey.split('.').reduce((acc, k) => (acc != null ? acc[k] : undefined), obj);
}

function main(argv: string[]): number {
  const cmd = argv[0];
  const paths = resolvePaths();

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  if (cmd === 'path') {
    process.stdout.write(JSON.stringify(paths, null, 2) + '\n');
    return 0;
  }

  if (cmd === 'status') {
    const state = readStateFile(paths.stateFile);
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
    process.stdout.write('\n--- summary ---\n');
    for (const id of ['main', 'fallback'] as const) {
      const p = state.providers[id];
      const url = p.rpcBaseUrl || '(unset)';
      const inCd = !!(p.cooldownUntilMs && p.cooldownUntilMs > Date.now());
      process.stdout.write(`provider ${id}: ${url} failures=${p.failures}${inCd ? ` (cooldown until ${new Date(p.cooldownUntilMs!).toISOString()})` : ''}\n`);
    }
    process.stdout.write(`round-robin counter: ${state.providersRoundRobinCounter}\n`);
    if (state.exclusive) {
      process.stdout.write(`exclusive held by: ${state.exclusive.ownerId} label=${state.exclusive.label} until=${new Date(state.exclusive.untilMs).toISOString()}\n`);
    } else {
      process.stdout.write('no exclusive held\n');
    }
    return 0;
  }

  if (cmd === 'metrics') {
    const json = argv.includes('--json');
    const limitArg = argv.find((arg) => arg.startsWith('--limit='));
    const limit = limitArg ? Math.max(1, Number(limitArg.slice('--limit='.length)) || 20) : 20;
    const metrics = readMetrics(paths.metricsFile);
    const report = buildMetricsComparison(metrics, Date.now(), limit);
    process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : formatMetricsComparison(report));
    return 0;
  }

  if (cmd === 'dump') {
    const state = readStateFile(paths.stateFile);
    process.stdout.write('--- state.json ---\n');
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
    process.stdout.write('--- bucket summary ---\n');
    for (const [name, b] of Object.entries(state.buckets)) {
      process.stdout.write(`${name}: nextSlotMs=${b.nextSlotMs} intervalMs=${b.intervalMs}\n`);
    }
    process.stdout.write('--- provider summary ---\n');
    for (const id of ['main', 'fallback'] as const) {
      const p = state.providers[id];
      const inCd = !!(p.cooldownUntilMs && p.cooldownUntilMs > Date.now());
      process.stdout.write(`${id}: url=${p.rpcBaseUrl || '(unset)'} failures=${p.failures}${inCd ? ` cooldownUntil=${new Date(p.cooldownUntilMs!).toISOString()}` : ''}\n`);
    }
    if (state.exclusive) {
      process.stdout.write('--- exclusive held ---\n');
      process.stdout.write(JSON.stringify(state.exclusive, null, 2) + '\n');
    } else {
      process.stdout.write('--- no exclusive held ---\n');
    }
    return 0;
  }

  if (cmd === 'reset') {
    const fresh: RpcLimiterState = {
      ...DEFAULT_CONFIG,
      providers: {
        main: { ...DEFAULT_CONFIG.providers.main },
        fallback: { ...DEFAULT_CONFIG.providers.fallback },
      },
      providersRoundRobinCounter: 0,
      buckets: { 'rpc:shared': { ...DEFAULT_BUCKET } },
      exclusive: null,
      lastExclusiveEndedAtMs: null,
      revision: 0,
    };
    writeStateFile(paths.stateFile, fresh);
    process.stdout.write('state.json reset to defaults\n');
    return 0;
  }

  if (cmd === 'set') {
    const pairs = argv.slice(1);
    if (pairs.length === 0) {
      process.stderr.write('set: missing key=value pairs\n');
      return 2;
    }
    const state = readStateFile(paths.stateFile);
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq <= 0) {
        process.stderr.write(`set: invalid argument '${pair}'\n`);
        return 2;
      }
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      setDeep(state, key, value);
      process.stdout.write(`set ${key}=${value}\n`);
    }
    writeStateFile(paths.stateFile, state);
    return 0;
  }

  process.stderr.write(`rpc-limiter: unknown command '${cmd}'\n`);
  process.stderr.write(HELP);
  return 2;
}

process.exit(main(process.argv.slice(2)));
