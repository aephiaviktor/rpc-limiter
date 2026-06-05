import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

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

export function resolvePaths(homeOverride?: string): RpcLimiterPaths {
  const env = homeOverride ?? process.env.RPC_LIMITER_HOME;
  const root = env
    ? path.resolve(env)
    : path.join(os.homedir(), '.rpc_limiter');

  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }

  return {
    root,
    lockfile: path.join(root, 'rpc.lock'),
    stateFile: path.join(root, 'state.json'),
    metricsLockfile: path.join(root, 'metrics.lock'),
    metricsFile: path.join(root, 'metrics.json'),
  };
}
