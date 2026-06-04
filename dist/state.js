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
exports.readState = readState;
exports.writeState = writeState;
exports.writeStateSync = writeStateSync;
exports.ensureBucket = ensureBucket;
exports.bumpRevision = bumpRevision;
const fs = __importStar(require("fs"));
const types_1 = require("./types");
let writeChain = Promise.resolve();
/**
 * Read state.json. If missing or malformed, return a fresh default state.
 * This is intentional: a corrupted file should not crash all 8 bots.
 *
 * Stale-slot safety: if a bucket's `nextSlotMs` is more than 30s in the
 * future relative to wall clock, we reset it. Protects against clock jumps
 * or bad state from a previous run.
 */
function readState(stateFile, now = Date.now()) {
    let raw;
    if (!fs.existsSync(stateFile)) {
        raw = freshState();
    }
    else {
        try {
            const text = fs.readFileSync(stateFile, 'utf8');
            const parsed = JSON.parse(text);
            raw = migrate(parsed, stateFile);
        }
        catch (err) {
            // Corrupt or partial write — back it up and start fresh.
            try {
                const backup = `${stateFile}.corrupt.${Date.now()}`;
                fs.copyFileSync(stateFile, backup);
            }
            catch {
                // best-effort
            }
            raw = freshState();
        }
    }
    // Stale-slot safety: clamp obviously-bad future timestamps.
    const STALE_FUTURE_MS = 30_000;
    for (const bucket of Object.values(raw.buckets)) {
        if (bucket.nextSlotMs > now + STALE_FUTURE_MS) {
            bucket.nextSlotMs = 0;
        }
    }
    if (raw.exclusive && raw.exclusive.untilMs < now - 60_000) {
        // 60s past the hard cap = definitely stale.
        raw.exclusive = null;
    }
    return raw;
}
/**
 * Atomic write: serialize through a chain so concurrent writers don't
 * interleave. Each write goes to a tmp file then is renamed.
 */
function writeState(stateFile, state) {
    const op = writeChain.then(async () => {
        const tmp = `${stateFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
        const text = JSON.stringify(state, null, 2);
        await fs.promises.writeFile(tmp, text, 'utf8');
        await fs.promises.rename(tmp, stateFile);
    });
    writeChain = op.catch(() => undefined);
    return op;
}
/**
 * Synchronous write for hot-path updates where the caller already holds
 * the lockfile and we want to avoid the async rename hop.
 *
 * IMPORTANT: caller must hold the lockfile. Otherwise races.
 */
function writeStateSync(stateFile, state) {
    const tmp = `${stateFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    const text = JSON.stringify(state, null, 2);
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, stateFile);
}
function freshState() {
    return {
        ...types_1.DEFAULT_CONFIG,
        buckets: {
            'rpc:shared': { ...types_1.DEFAULT_BUCKET },
        },
        exclusive: null,
        lastExclusiveEndedAtMs: null,
        revision: 0,
    };
}
function migrate(state, stateFile) {
    if (!state || typeof state !== 'object') {
        return freshState();
    }
    if (state.version !== types_1.STATE_VERSION) {
        // Future: write migration shims. For now, fresh state is the safest fallback.
        return freshState();
    }
    // Defensive defaults for missing fields.
    state.enabled = state.enabled ?? types_1.DEFAULT_CONFIG.enabled;
    state.apiKey = state.apiKey ?? types_1.DEFAULT_CONFIG.apiKey;
    state.rpcBaseUrl = state.rpcBaseUrl ?? types_1.DEFAULT_CONFIG.rpcBaseUrl;
    state.limits = state.limits ?? types_1.DEFAULT_CONFIG.limits;
    state.buckets = state.buckets ?? { 'rpc:shared': { ...types_1.DEFAULT_BUCKET } };
    state.exclusive = state.exclusive ?? null;
    state.lastExclusiveEndedAtMs = state.lastExclusiveEndedAtMs ?? null;
    state.revision = state.revision ?? 0;
    return state;
}
function ensureBucket(state, name, defaultIntervalMs) {
    if (!state.buckets[name]) {
        state.buckets[name] = { nextSlotMs: 0, intervalMs: defaultIntervalMs };
    }
    return state.buckets[name];
}
function bumpRevision(state) {
    state.revision = (state.revision + 1) | 0;
}
//# sourceMappingURL=state.js.map