import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { isTransientRenameError, readState, writeStateSync } from '../src/state';

describe('state persistence', () => {
  it('writes and reads state atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-limiter-state-'));
    const stateFile = path.join(dir, 'state.json');
    const state = readState(stateFile);
    state.revision = 7;

    writeStateSync(stateFile, state);

    expect(readState(stateFile).revision).toBe(7);
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retries only transient Windows rename failures', () => {
    for (const code of ['EPERM', 'EBUSY', 'ENOTEMPTY']) {
      expect(isTransientRenameError(Object.assign(new Error('rename failed'), { code }), 'win32')).toBe(true);
    }
    expect(isTransientRenameError(Object.assign(new Error('rename failed'), { code: 'EACCES' }), 'win32')).toBe(false);
    expect(isTransientRenameError(Object.assign(new Error('rename failed'), { code: 'EPERM' }), 'linux')).toBe(false);
  });
});
