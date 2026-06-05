import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildMetricsComparison,
  formatMetricsComparison,
  normalizeRpcMethod,
  readMetrics,
  recordRpcMetric,
  resolvePaths,
} from '../src';

function freshHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rpc_limiter_metrics_test_'));
}

describe('RPC metrics', () => {
  it('normalizes Solana Connection methods to Helius-style method names', () => {
    expect(normalizeRpcMethod('Connection.getAccountInfo()')).toBe('GET_ACCOUNT_INFO');
    expect(normalizeRpcMethod('fallback Connection.getParsedTokenAccountsByOwner()')).toBe('GET_TOKEN_ACCOUNTS_BY_OWNER');
    expect(normalizeRpcMethod('sendRawTransaction')).toBe('SEND_TRANSACTION');
    expect(normalizeRpcMethod('getLatestBlockhash')).toBe('GET_LATEST_BLOCKHASH');
  });

  it('records minute/hour/day counters and compares last 24h to previous 7-day average', async () => {
    const home = freshHome();
    const paths = resolvePaths(home);
    const now = Date.parse('2026-06-08T12:00:00.000Z');
    const todayStart = Date.parse('2026-06-08T00:00:00.000Z');
    const dayMs = 24 * 60 * 60 * 1000;

    try {
      for (let day = 1; day <= 7; day++) {
        const timestamp = todayStart - day * dayMs + 60 * 60 * 1000;
        for (let i = 0; i < 10; i++) {
          await recordRpcMetric(paths, {
            app: 'GM Market Bot',
            profile: 'default',
            method: 'getAccountInfo',
            bucket: 'rpc:shared',
          }, timestamp + i);
        }
      }

      for (let i = 0; i < 40; i++) {
        await recordRpcMetric(paths, {
          app: 'GM Market Bot',
          profile: 'default',
          method: 'getAccountInfo',
          bucket: 'rpc:shared',
          waitMs: i === 0 ? 100 : 0,
        }, now - 60_000 + i);
      }

      const metrics = readMetrics(paths.metricsFile, now);
      const report = buildMetricsComparison(metrics, now, 10);
      const accountInfo = report.methods.find((row) => row.method === 'GET_ACCOUNT_INFO');
      const source = report.sources.find((row) => row.app === 'GM Market Bot' && row.method === 'GET_ACCOUNT_INFO');

      expect(report.baselineDays).toBe(7);
      expect(accountInfo?.last24h).toBe(40);
      expect(accountInfo?.previous7dAverage).toBe(10);
      expect(accountInfo?.delta).toBe(30);
      expect(source?.last24h).toBe(40);
      expect(formatMetricsComparison(report)).toContain('GET_ACCOUNT_INFO');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
