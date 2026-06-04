import * as crypto from 'crypto';

/**
 * Generate a process-unique owner id: pid + random nonce.
 * Used for the exclusive holder field, and stamped into logs.
 *
 * Why not just pid? Because a process can restart and reuse the same pid
 * while the previous run still held the exclusive. The nonce makes owner
 * identity unique across restarts, so the live process can take over from
 * itself (good: re-acquire is idempotent) and a new process is correctly
 * treated as a different owner (good: stale-recovery is correct).
 */
export function ownerId(): string {
  const nonce = crypto.randomBytes(4).toString('hex');
  return `${process.pid}:${nonce}`;
}
