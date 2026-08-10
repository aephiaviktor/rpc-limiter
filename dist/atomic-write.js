"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_STALE_TEMP_AGE_MS = exports.WINDOWS_RENAME_RETRY_DELAYS_MS = void 0;
exports.isTransientRenameError = isTransientRenameError;
exports.renameWithRetrySync = renameWithRetrySync;
exports.renameWithRetry = renameWithRetry;
exports.removeTempFileSync = removeTempFileSync;
exports.atomicWriteFileSync = atomicWriteFileSync;
exports.removeTempFile = removeTempFile;
exports.cleanupStaleTempFilesSync = cleanupStaleTempFilesSync;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
exports.WINDOWS_RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200];
exports.DEFAULT_STALE_TEMP_AGE_MS = 5 * 60_000;
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
function isTransientRenameError(error, platform = process.platform) {
    if (platform !== 'win32' || !error || typeof error !== 'object' || !('code' in error)) {
        return false;
    }
    return TRANSIENT_RENAME_CODES.has(String(error.code ?? '').toUpperCase());
}
function sleepSync(ms) {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}
function renameWithRetrySync(tmp, destination, platform = process.platform, delaysMs = exports.WINDOWS_RENAME_RETRY_DELAYS_MS, rename = fs.renameSync) {
    for (let attempt = 0;; attempt++) {
        try {
            rename(tmp, destination);
            return;
        }
        catch (error) {
            const delayMs = delaysMs[attempt];
            if (!isTransientRenameError(error, platform) || delayMs === undefined)
                throw error;
            sleepSync(delayMs);
        }
    }
}
async function renameWithRetry(tmp, destination, platform = process.platform, delaysMs = exports.WINDOWS_RENAME_RETRY_DELAYS_MS) {
    for (let attempt = 0;; attempt++) {
        try {
            await fs.promises.rename(tmp, destination);
            return;
        }
        catch (error) {
            const delayMs = delaysMs[attempt];
            if (!isTransientRenameError(error, platform) || delayMs === undefined)
                throw error;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}
function warnCleanupFailure(file, error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[rpc_limiter] Failed to remove temporary file ${file}: ${message}`);
}
function removeTempFileSync(tmp) {
    try {
        if (fs.existsSync(tmp))
            fs.unlinkSync(tmp);
    }
    catch (error) {
        warnCleanupFailure(tmp, error);
    }
}
function atomicWriteFileSync(destination, text, options = {}) {
    const tmp = `${destination}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    try {
        fs.writeFileSync(tmp, text, 'utf8');
        renameWithRetrySync(tmp, destination, options.platform, options.delaysMs, options.rename);
    }
    finally {
        removeTempFileSync(tmp);
    }
}
async function removeTempFile(tmp) {
    try {
        await fs.promises.unlink(tmp);
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            warnCleanupFailure(tmp, error);
    }
}
function cleanupStaleTempFilesSync(destination, nowMs = Date.now(), staleAgeMs = exports.DEFAULT_STALE_TEMP_AGE_MS) {
    const dir = path.dirname(destination);
    const prefix = `${path.basename(destination)}.tmp.`;
    let removed = 0;
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return 0;
    }
    for (const name of names) {
        if (!name.startsWith(prefix))
            continue;
        const file = path.join(dir, name);
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.mtimeMs > nowMs - staleAgeMs)
                continue;
            fs.unlinkSync(file);
            removed++;
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                warnCleanupFailure(file, error);
        }
    }
    return removed;
}
//# sourceMappingURL=atomic-write.js.map