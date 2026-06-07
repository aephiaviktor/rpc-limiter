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
exports.ownerId = ownerId;
const crypto = __importStar(require("crypto"));
const PROCESS_OWNER_ID = `${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
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
function ownerId() {
    return PROCESS_OWNER_ID;
}
//# sourceMappingURL=owner.js.map