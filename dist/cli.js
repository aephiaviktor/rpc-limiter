#!/usr/bin/env node
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
const fs = __importStar(require("fs"));
const paths_1 = require("./paths");
const types_1 = require("./types");
const metrics_1 = require("./metrics");
const HELP = `rpc-limiter — cross-process RPC rate limiter for shared Helius keys

Usage:
  rpc-limiter status
  rpc-limiter dump
  rpc-limiter set <key>=<value> [<key>=<value> ...]
  rpc-limiter reset
  rpc-limiter path
  rpc-limiter metrics [--json] [--limit=<n>]

Keys for 'set':
  enabled=true|false
  apiKey=<value>
  rpcBaseUrl=<url>
  buckets.rpc:shared.intervalMs=<ms>
  limits.maxExclusiveMs=<ms>
  limits.minNormalMsBetweenExclusives=<ms>

Env:
  RPC_LIMITER_HOME  Override shared state directory (default: ~/.rpc_limiter)

Examples:
  rpc-limiter set apiKey=61b4b51d-... rpcBaseUrl=https://mainnet.helius-rpc.com
  rpc-limiter set buckets.rpc:shared.intervalMs=200
  rpc-limiter status
  rpc-limiter metrics
`;
function readStateFile(file) {
    if (!fs.existsSync(file)) {
        return {
            ...types_1.DEFAULT_CONFIG,
            buckets: { 'rpc:shared': { ...types_1.DEFAULT_BUCKET } },
            exclusive: null,
            lastExclusiveEndedAtMs: null,
            revision: 0,
        };
    }
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text);
}
function writeStateFile(file, state) {
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
}
function setDeep(obj, dottedKey, value) {
    const parts = dottedKey.split('.');
    let cursor = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (typeof cursor[k] !== 'object' || cursor[k] === null) {
            cursor[k] = {};
        }
        cursor = cursor[k];
    }
    const last = parts[parts.length - 1];
    // Coerce numbers
    if (/^-?\d+(\.\d+)?$/.test(value)) {
        cursor[last] = Number(value);
    }
    else if (value === 'true' || value === 'false') {
        cursor[last] = value === 'true';
    }
    else {
        cursor[last] = value;
    }
}
function getDeep(obj, dottedKey) {
    return dottedKey.split('.').reduce((acc, k) => (acc != null ? acc[k] : undefined), obj);
}
function main(argv) {
    const cmd = argv[0];
    const paths = (0, paths_1.resolvePaths)();
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
        process.stdout.write(HELP);
        return 0;
    }
    if (cmd === 'path') {
        process.stdout.write(JSON.stringify(paths, null, 2) + '\n');
        return 0;
    }
    if (cmd === 'status') {
        const state = readStateFile(paths.stateFile);
        process.stdout.write(JSON.stringify(state, null, 2) + '\n');
        return 0;
    }
    if (cmd === 'metrics') {
        const json = argv.includes('--json');
        const limitArg = argv.find((arg) => arg.startsWith('--limit='));
        const limit = limitArg ? Math.max(1, Number(limitArg.slice('--limit='.length)) || 20) : 20;
        const metrics = (0, metrics_1.readMetrics)(paths.metricsFile);
        const report = (0, metrics_1.buildMetricsComparison)(metrics, Date.now(), limit);
        process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : (0, metrics_1.formatMetricsComparison)(report));
        return 0;
    }
    if (cmd === 'dump') {
        const state = readStateFile(paths.stateFile);
        process.stdout.write('--- state.json ---\n');
        process.stdout.write(JSON.stringify(state, null, 2) + '\n');
        process.stdout.write('--- bucket summary ---\n');
        for (const [name, b] of Object.entries(state.buckets)) {
            process.stdout.write(`${name}: nextSlotMs=${b.nextSlotMs} intervalMs=${b.intervalMs}\n`);
        }
        if (state.exclusive) {
            process.stdout.write('--- exclusive held ---\n');
            process.stdout.write(JSON.stringify(state.exclusive, null, 2) + '\n');
        }
        else {
            process.stdout.write('--- no exclusive held ---\n');
        }
        return 0;
    }
    if (cmd === 'reset') {
        const fresh = {
            ...types_1.DEFAULT_CONFIG,
            buckets: { 'rpc:shared': { ...types_1.DEFAULT_BUCKET } },
            exclusive: null,
            lastExclusiveEndedAtMs: null,
            revision: 0,
        };
        writeStateFile(paths.stateFile, fresh);
        process.stdout.write('state.json reset to defaults\n');
        return 0;
    }
    if (cmd === 'set') {
        const pairs = argv.slice(1);
        if (pairs.length === 0) {
            process.stderr.write('set: missing key=value pairs\n');
            return 2;
        }
        const state = readStateFile(paths.stateFile);
        for (const pair of pairs) {
            const eq = pair.indexOf('=');
            if (eq <= 0) {
                process.stderr.write(`set: invalid argument '${pair}'\n`);
                return 2;
            }
            const key = pair.slice(0, eq);
            const value = pair.slice(eq + 1);
            setDeep(state, key, value);
            process.stdout.write(`set ${key}=${value}\n`);
        }
        writeStateFile(paths.stateFile, state);
        return 0;
    }
    process.stderr.write(`rpc-limiter: unknown command '${cmd}'\n`);
    process.stderr.write(HELP);
    return 2;
}
process.exit(main(process.argv.slice(2)));
//# sourceMappingURL=cli.js.map