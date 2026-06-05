import * as fs from 'fs';
import * as lockfile from 'proper-lockfile';
import { RpcLimiterPaths } from './paths';

export const METRICS_VERSION = 1;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_METRICS_RETENTION = {
  minuteMs: 48 * HOUR_MS,
  hourMs: 30 * DAY_MS,
  dayMs: 180 * DAY_MS,
};

export interface RpcMetricLabels {
  app?: string;
  profile?: string;
  method?: string;
}

export interface RpcMetricSample extends RpcMetricLabels {
  bucket: string;
  waitMs?: number;
  rejected?: boolean;
}

export interface RpcMetricCounter {
  app: string;
  profile: string;
  method: string;
  bucket: string;
  count: number;
  waitedCount: number;
  totalWaitMs: number;
  maxWaitMs: number;
  rejectedCount: number;
  lastAtMs: number;
}

export interface RpcMetricsState {
  version: 1;
  updatedAtMs: number;
  retention: typeof DEFAULT_METRICS_RETENTION;
  minutes: Record<string, Record<string, RpcMetricCounter>>;
  hours: Record<string, Record<string, RpcMetricCounter>>;
  days: Record<string, Record<string, RpcMetricCounter>>;
}

export interface RpcMetricComparisonRow {
  method: string;
  bucket: string;
  last24h: number;
  previous7dAverage: number;
  delta: number;
  deltaPercent: number | null;
}

export interface RpcMetricSourceDeltaRow {
  app: string;
  profile: string;
  method: string;
  bucket: string;
  last24h: number;
  previous7dAverage: number;
  delta: number;
  deltaPercent: number | null;
}

export interface RpcMetricComparison {
  generatedAtMs: number;
  baselineDays: number;
  methods: RpcMetricComparisonRow[];
  sources: RpcMetricSourceDeltaRow[];
}

export async function recordRpcMetric(
  paths: RpcLimiterPaths,
  sample: RpcMetricSample,
  nowMs: number = Date.now(),
  lockOptions: lockfile.LockOptions = {},
): Promise<void> {
  ensureFile(paths.metricsLockfile, '');
  const release = await lockfile.lock(paths.metricsLockfile, {
    stale: 5_000,
    retries: { retries: 10, minTimeout: 5, maxTimeout: 50, factor: 1.2 },
    realpath: false,
    ...lockOptions,
  });

  try {
    const metrics = readMetrics(paths.metricsFile, nowMs);
    addSample(metrics.minutes, minuteKey(nowMs), sample, nowMs);
    addSample(metrics.hours, hourKey(nowMs), sample, nowMs);
    addSample(metrics.days, dayKey(nowMs), sample, nowMs);
    pruneMetrics(metrics, nowMs);
    metrics.updatedAtMs = nowMs;
    writeMetricsSync(paths.metricsFile, metrics);
  } finally {
    try {
      await release();
    } catch {
      // best-effort
    }
  }
}

export function readMetrics(metricsFile: string, nowMs: number = Date.now()): RpcMetricsState {
  if (!fs.existsSync(metricsFile)) {
    return freshMetrics(nowMs);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(metricsFile, 'utf8')) as RpcMetricsState;
    if (!parsed || parsed.version !== METRICS_VERSION) {
      return freshMetrics(nowMs);
    }

    parsed.updatedAtMs = Number(parsed.updatedAtMs) || nowMs;
    parsed.retention = { ...DEFAULT_METRICS_RETENTION, ...(parsed.retention ?? {}) };
    parsed.minutes = parsed.minutes ?? {};
    parsed.hours = parsed.hours ?? {};
    parsed.days = parsed.days ?? {};
    pruneMetrics(parsed, nowMs);
    return parsed;
  } catch {
    try {
      fs.copyFileSync(metricsFile, `${metricsFile}.corrupt.${Date.now()}`);
    } catch {
      // best-effort
    }
    return freshMetrics(nowMs);
  }
}

export function writeMetricsSync(metricsFile: string, metrics: RpcMetricsState): void {
  const tmp = `${metricsFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, JSON.stringify(metrics, null, 2), 'utf8');
  fs.renameSync(tmp, metricsFile);
}

export function buildMetricsComparison(
  metrics: RpcMetricsState,
  nowMs: number = Date.now(),
  limit: number = 20,
): RpcMetricComparison {
  const last24hStart = nowMs - DAY_MS;
  const last24h = aggregateRange(metrics.hours, 'hour', last24hStart, nowMs);
  const todayStart = startOfUtcDay(nowMs);
  const baselineStart = todayStart - 7 * DAY_MS;
  const baselineEnd = todayStart;
  const baseline = aggregateRange(metrics.days, 'day', baselineStart, baselineEnd);
  const baselineDays = countDayWindows(metrics.days, baselineStart, baselineEnd);

  const methodsByKey = new Map<string, RpcMetricComparisonRow>();
  const sourceKeys = new Set([...last24h.bySource.keys(), ...baseline.bySource.keys()]);

  for (const [key, count] of last24h.byMethod) {
    const base = baseline.byMethod.get(key) ?? 0;
    const average = baselineDays > 0 ? base / baselineDays : 0;
    methodsByKey.set(key, makeMethodRow(key, count, average));
  }

  for (const [key, count] of baseline.byMethod) {
    if (methodsByKey.has(key)) continue;
    const average = baselineDays > 0 ? count / baselineDays : 0;
    methodsByKey.set(key, makeMethodRow(key, 0, average));
  }

  const sources = [...sourceKeys]
    .map((key) => {
      const last = last24h.bySource.get(key) ?? 0;
      const base = baseline.bySource.get(key) ?? 0;
      const average = baselineDays > 0 ? base / baselineDays : 0;
      return makeSourceRow(key, last, average);
    })
    .sort(compareDeltaRows)
    .slice(0, limit);

  return {
    generatedAtMs: nowMs,
    baselineDays,
    methods: [...methodsByKey.values()].sort(compareDeltaRows).slice(0, limit),
    sources,
  };
}

export function formatMetricsComparison(report: RpcMetricComparison): string {
  const lines: string[] = [];
  lines.push('RPC limiter metrics: last 24h vs previous 7-day average');
  lines.push(`Generated: ${new Date(report.generatedAtMs).toISOString()}`);
  lines.push(`Baseline days with data: ${report.baselineDays}`);
  lines.push('');
  lines.push('By method:');

  if (report.methods.length === 0) {
    lines.push('  No metrics recorded yet.');
  } else {
    for (const row of report.methods) {
      lines.push(
        `  ${pad(`${row.method} (${row.bucket})`, 42)} last24=${padNumber(row.last24h)} avg/day=${padNumber(row.previous7dAverage)} delta=${formatDelta(row)}`,
      );
    }
  }

  lines.push('');
  lines.push('Top source deltas:');
  if (report.sources.length === 0) {
    lines.push('  No source metrics recorded yet.');
  } else {
    for (const row of report.sources) {
      const source = `${row.app}${row.profile === 'default' ? '' : `/${row.profile}`} ${row.method}`;
      lines.push(
        `  ${pad(source, 42)} last24=${padNumber(row.last24h)} avg/day=${padNumber(row.previous7dAverage)} delta=${formatDelta(row)}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function normalizeRpcMethod(input: string | undefined): string {
  const raw = String(input ?? '').trim();
  const withoutConnection = raw
    .replace(/^fallback\s+/i, '')
    .replace(/^Connection\./, '')
    .replace(/\(\)$/, '');
  const lower = withoutConnection.toLowerCase();

  if (lower === 'getaccountinfo' || lower === 'getparsedaccountinfo') return 'GET_ACCOUNT_INFO';
  if (lower === 'getmultipleaccountsinfo' || lower === 'getmultipleaccounts') return 'GET_MULTIPLE_ACCOUNTS';
  if (lower === 'gettokenaccountsbyowner' || lower === 'getparsedtokenaccountsbyowner') {
    return 'GET_TOKEN_ACCOUNTS_BY_OWNER';
  }
  if (lower === 'getbalance') return 'GET_BALANCE';
  if (lower === 'sendrawtransaction' || lower === 'sendtransaction') return 'SEND_TRANSACTION';
  if (lower === 'getprogramaccounts' || lower === 'getparsedprogramaccounts') return 'GET_PROGRAM_ACCOUNTS';
  if (lower === 'getlatestblockhash') return 'GET_LATEST_BLOCKHASH';
  if (lower === 'getsignaturestatuses' || lower === 'confirmtransaction') return 'GET_SIGNATURE_STATUSES';

  const snake = withoutConnection
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return snake || 'UNKNOWN';
}

function freshMetrics(nowMs: number): RpcMetricsState {
  return {
    version: METRICS_VERSION,
    updatedAtMs: nowMs,
    retention: { ...DEFAULT_METRICS_RETENTION },
    minutes: {},
    hours: {},
    days: {},
  };
}

function addSample(
  windows: Record<string, Record<string, RpcMetricCounter>>,
  windowKey: string,
  sample: RpcMetricSample,
  nowMs: number,
): void {
  const normalized = normalizeSample(sample);
  const key = metricKey(normalized);
  const window = windows[windowKey] ?? {};
  windows[windowKey] = window;
  const counter = window[key] ?? {
    app: normalized.app,
    profile: normalized.profile,
    method: normalized.method,
    bucket: normalized.bucket,
    count: 0,
    waitedCount: 0,
    totalWaitMs: 0,
    maxWaitMs: 0,
    rejectedCount: 0,
    lastAtMs: nowMs,
  };

  if (normalized.rejected) {
    counter.rejectedCount += 1;
  } else {
    counter.count += 1;
  }

  const waitMs = Math.max(0, Math.round(normalized.waitMs ?? 0));
  if (waitMs > 0) {
    counter.waitedCount += 1;
    counter.totalWaitMs += waitMs;
    counter.maxWaitMs = Math.max(counter.maxWaitMs, waitMs);
  }
  counter.lastAtMs = nowMs;
  window[key] = counter;
}

function normalizeSample(sample: RpcMetricSample): Required<RpcMetricSample> {
  return {
    app: cleanLabel(sample.app, 'unknown-app'),
    profile: cleanLabel(sample.profile, 'default'),
    method: normalizeRpcMethod(sample.method),
    bucket: cleanLabel(sample.bucket, 'unknown-bucket'),
    waitMs: Math.max(0, Math.round(sample.waitMs ?? 0)),
    rejected: Boolean(sample.rejected),
  };
}

function cleanLabel(value: string | undefined, fallback: string): string {
  const cleaned = String(value ?? '').trim();
  return cleaned || fallback;
}

function metricKey(sample: Required<RpcMetricSample>): string {
  return [
    encodeURIComponent(sample.app),
    encodeURIComponent(sample.profile),
    encodeURIComponent(sample.bucket),
    encodeURIComponent(sample.method),
  ].join('|');
}

function splitMetricKey(key: string): { app: string; profile: string; bucket: string; method: string } {
  const [app = '', profile = '', bucket = '', method = ''] = key.split('|').map(decodeURIComponent);
  return { app, profile, bucket, method };
}

function pruneMetrics(metrics: RpcMetricsState, nowMs: number): void {
  pruneWindows(metrics.minutes, 'minute', nowMs - metrics.retention.minuteMs);
  pruneWindows(metrics.hours, 'hour', nowMs - metrics.retention.hourMs);
  pruneWindows(metrics.days, 'day', nowMs - metrics.retention.dayMs);
}

function pruneWindows(windows: Record<string, unknown>, scope: 'minute' | 'hour' | 'day', minMs: number): void {
  for (const key of Object.keys(windows)) {
    if (windowStartMs(scope, key) < minMs) {
      delete windows[key];
    }
  }
}

function aggregateRange(
  windows: Record<string, Record<string, RpcMetricCounter>>,
  scope: 'minute' | 'hour' | 'day',
  startMs: number,
  endMs: number,
): { byMethod: Map<string, number>; bySource: Map<string, number> } {
  const byMethod = new Map<string, number>();
  const bySource = new Map<string, number>();

  for (const [windowKey, counters] of Object.entries(windows)) {
    const ts = windowStartMs(scope, windowKey);
    if (ts < startMs || ts >= endMs) continue;

    for (const [key, counter] of Object.entries(counters)) {
      const labels = splitMetricKey(key);
      const methodKey = `${labels.bucket}|${labels.method}`;
      const sourceKey = `${labels.app}|${labels.profile}|${labels.bucket}|${labels.method}`;
      byMethod.set(methodKey, (byMethod.get(methodKey) ?? 0) + counter.count);
      bySource.set(sourceKey, (bySource.get(sourceKey) ?? 0) + counter.count);
    }
  }

  return { byMethod, bySource };
}

function countDayWindows(
  windows: Record<string, Record<string, RpcMetricCounter>>,
  startMs: number,
  endMs: number,
): number {
  let count = 0;
  for (const key of Object.keys(windows)) {
    const ts = windowStartMs('day', key);
    if (ts >= startMs && ts < endMs) count += 1;
  }
  return count;
}

function makeMethodRow(key: string, last24h: number, previous7dAverage: number): RpcMetricComparisonRow {
  const [bucket, method] = key.split('|');
  const delta = last24h - previous7dAverage;
  return {
    method,
    bucket,
    last24h,
    previous7dAverage,
    delta,
    deltaPercent: previous7dAverage > 0 ? (delta / previous7dAverage) * 100 : null,
  };
}

function makeSourceRow(key: string, last24h: number, previous7dAverage: number): RpcMetricSourceDeltaRow {
  const [app, profile, bucket, method] = key.split('|');
  const delta = last24h - previous7dAverage;
  return {
    app,
    profile,
    method,
    bucket,
    last24h,
    previous7dAverage,
    delta,
    deltaPercent: previous7dAverage > 0 ? (delta / previous7dAverage) * 100 : null,
  };
}

function compareDeltaRows<T extends { delta: number; last24h: number }>(a: T, b: T): number {
  return Math.abs(b.delta) - Math.abs(a.delta) || b.last24h - a.last24h;
}

function minuteKey(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString().slice(0, 16);
}

function hourKey(ms: number): string {
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13);
}

function dayKey(ms: number): string {
  return new Date(startOfUtcDay(ms)).toISOString().slice(0, 10);
}

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function windowStartMs(scope: 'minute' | 'hour' | 'day', key: string): number {
  if (scope === 'minute') return Date.parse(`${key}:00.000Z`);
  if (scope === 'hour') return Date.parse(`${key}:00:00.000Z`);
  return Date.parse(`${key}T00:00:00.000Z`);
}

function ensureFile(file: string, contents: string): void {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, contents, 'utf8');
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US').padStart(8);
}

function formatDelta(row: { delta: number; deltaPercent: number | null }): string {
  const rounded = Math.round(row.delta).toLocaleString('en-US');
  const prefix = row.delta > 0 ? '+' : '';
  if (row.deltaPercent === null) return `${prefix}${rounded} (n/a)`;
  return `${prefix}${rounded} (${prefix}${Math.round(row.deltaPercent)}%)`;
}
