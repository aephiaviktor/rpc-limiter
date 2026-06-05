/**
 * Resolves the shared rpc_limiter directory.
 *
 * Priority:
 *   1. RPC_LIMITER_HOME env var (always honored, even if missing)
 *   2. ~/.rpc_limiter (OS user home, portable across Linux/macOS/Windows)
 *
 * Ensures the directory exists. Returns absolute paths for lockfile and state.
 */
export interface RpcLimiterPaths {
    root: string;
    lockfile: string;
    stateFile: string;
    metricsLockfile: string;
    metricsFile: string;
}
export declare function resolvePaths(homeOverride?: string): RpcLimiterPaths;
//# sourceMappingURL=paths.d.ts.map