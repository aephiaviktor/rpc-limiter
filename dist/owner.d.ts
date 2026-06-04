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
export declare function ownerId(): string;
//# sourceMappingURL=owner.d.ts.map