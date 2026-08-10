import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  atomicWriteFileSync,
  cleanupStaleTempFilesSync,
  renameWithRetrySync,
} from '../src/atomic-write';
import { readMetrics, writeMetricsSync } from '../src/metrics';
import { readState, writeStateSync } from '../src/state';

const dirs: string[] = [];
function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-limiter-atomic-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('defensive atomic persistence', () => {
  it('writes metrics and state successfully without leaving temp files', () => {
    const dir = freshDir();
    const metricsFile = path.join(dir, 'metrics.json');
    const stateFile = path.join(dir, 'state.json');
    writeMetricsSync(metricsFile, readMetrics(metricsFile));
    const state = readState(stateFile);
    state.revision = 9;
    writeStateSync(stateFile, state);
    expect(JSON.parse(fs.readFileSync(metricsFile, 'utf8')).version).toBe(1);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).revision).toBe(9);
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('cleans its metrics temp file after final rename failure', () => {
    const dir = freshDir();
    const metricsFile = path.join(dir, 'metrics.json');
    const failRename = (() => {
      throw Object.assign(new Error('forced failure'), { code: 'EIO' });
    }) as typeof fs.renameSync;
    expect(() => atomicWriteFileSync(metricsFile, '{}', { rename: failRename })).toThrow('forced failure');
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('cleans its state temp file after final rename failure', () => {
    const dir = freshDir();
    const stateFile = path.join(dir, 'state.json');
    const failRename = (() => {
      throw Object.assign(new Error('forced failure'), { code: 'EIO' });
    }) as typeof fs.renameSync;
    expect(() => atomicWriteFileSync(stateFile, '{}', { rename: failRename })).toThrow('forced failure');
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('retries transient Windows contention and then succeeds', () => {
    const dir = freshDir();
    const tmp = path.join(dir, 'state.json.tmp.test');
    const destination = path.join(dir, 'state.json');
    fs.writeFileSync(tmp, '{}');
    let calls = 0;
    const rename = ((from: fs.PathLike, to: fs.PathLike) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      fs.renameSync(from, to);
    }) as typeof fs.renameSync;
    renameWithRetrySync(tmp, destination, 'win32', [0], rename);
    expect(calls).toBe(2);
    expect(JSON.parse(fs.readFileSync(destination, 'utf8'))).toEqual({});
  });

  it('removes only stale matching temp files and preserves fresh/current files', () => {
    const dir = freshDir();
    const destination = path.join(dir, 'metrics.json');
    const stale = `${destination}.tmp.1.stale`;
    const fresh = `${destination}.tmp.2.active`;
    const unrelated = path.join(dir, 'evidence.json');
    fs.writeFileSync(destination, '{}');
    fs.writeFileSync(stale, 'old');
    fs.writeFileSync(fresh, 'new');
    fs.writeFileSync(unrelated, 'keep');
    const now = Date.now();
    fs.utimesSync(stale, new Date(now - 600_000), new Date(now - 600_000));
    expect(cleanupStaleTempFilesSync(destination, now, 300_000)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(destination)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
