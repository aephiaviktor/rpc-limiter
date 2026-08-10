import * as fs from 'fs';
export declare const WINDOWS_RENAME_RETRY_DELAYS_MS: number[];
export declare const DEFAULT_STALE_TEMP_AGE_MS: number;
export declare function isTransientRenameError(error: unknown, platform?: NodeJS.Platform): boolean;
export declare function renameWithRetrySync(tmp: string, destination: string, platform?: NodeJS.Platform, delaysMs?: readonly number[], rename?: typeof fs.renameSync): void;
export declare function renameWithRetry(tmp: string, destination: string, platform?: NodeJS.Platform, delaysMs?: readonly number[]): Promise<void>;
export declare function removeTempFileSync(tmp: string): void;
export declare function atomicWriteFileSync(destination: string, text: string, options?: {
    platform?: NodeJS.Platform;
    delaysMs?: readonly number[];
    rename?: typeof fs.renameSync;
}): void;
export declare function removeTempFile(tmp: string): Promise<void>;
export declare function cleanupStaleTempFilesSync(destination: string, nowMs?: number, staleAgeMs?: number): number;
//# sourceMappingURL=atomic-write.d.ts.map