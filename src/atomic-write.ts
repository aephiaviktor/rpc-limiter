import * as fs from 'fs';
import * as path from 'path';

export const WINDOWS_RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200];
export const DEFAULT_STALE_TEMP_AGE_MS = 5 * 60_000;
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);

export function isTransientRenameError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32' || !error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  return TRANSIENT_RENAME_CODES.has(String((error as NodeJS.ErrnoException).code ?? '').toUpperCase());
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

export function renameWithRetrySync(
  tmp: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
  delaysMs: readonly number[] = WINDOWS_RENAME_RETRY_DELAYS_MS,
  rename: typeof fs.renameSync = fs.renameSync,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, destination);
      return;
    } catch (error) {
      const delayMs = delaysMs[attempt];
      if (!isTransientRenameError(error, platform) || delayMs === undefined) throw error;
      sleepSync(delayMs);
    }
  }
}

export async function renameWithRetry(
  tmp: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
  delaysMs: readonly number[] = WINDOWS_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmp, destination);
      return;
    } catch (error) {
      const delayMs = delaysMs[attempt];
      if (!isTransientRenameError(error, platform) || delayMs === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function warnCleanupFailure(file: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[rpc_limiter] Failed to remove temporary file ${file}: ${message}`);
}

export function removeTempFileSync(tmp: string): void {
  try {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch (error) {
    warnCleanupFailure(tmp, error);
  }
}

export function atomicWriteFileSync(
  destination: string,
  text: string,
  options: {
    platform?: NodeJS.Platform;
    delaysMs?: readonly number[];
    rename?: typeof fs.renameSync;
  } = {},
): void {
  const tmp = `${destination}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    renameWithRetrySync(
      tmp,
      destination,
      options.platform,
      options.delaysMs,
      options.rename,
    );
  } finally {
    removeTempFileSync(tmp);
  }
}

export async function removeTempFile(tmp: string): Promise<void> {
  try {
    await fs.promises.unlink(tmp);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') warnCleanupFailure(tmp, error);
  }
}

export function cleanupStaleTempFilesSync(
  destination: string,
  nowMs: number = Date.now(),
  staleAgeMs: number = DEFAULT_STALE_TEMP_AGE_MS,
): number {
  const dir = path.dirname(destination);
  const prefix = `${path.basename(destination)}.tmp.`;
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.mtimeMs > nowMs - staleAgeMs) continue;
      fs.unlinkSync(file);
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') warnCleanupFailure(file, error);
    }
  }
  return removed;
}
