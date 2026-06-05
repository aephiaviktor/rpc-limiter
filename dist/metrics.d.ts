import * as lockfile from 'proper-lockfile';
import { RpcLimiterPaths } from './paths';
export declare const METRICS_VERSION = 1;
export declare const DEFAULT_METRICS_RETENTION: {
    minuteMs: number;
    hourMs: number;
    dayMs: number;
};
export interface RpcMetricLabels {
    app?: string;
    profile?: string;
    method?: string;
}
export interface RpcMetricSample extends RpcMetricLabels {
    bucket: string;
    waitMs?: number;
    rejected?: boolean;
}
export interface RpcMetricCounter {
    app: string;
    profile: string;
    method: string;
    bucket: string;
    count: number;
    waitedCount: number;
    totalWaitMs: number;
    maxWaitMs: number;
    rejectedCount: number;
    lastAtMs: number;
}
export interface RpcMetricsState {
    version: 1;
    updatedAtMs: number;
    retention: typeof DEFAULT_METRICS_RETENTION;
    minutes: Record<string, Record<string, RpcMetricCounter>>;
    hours: Record<string, Record<string, RpcMetricCounter>>;
    days: Record<string, Record<string, RpcMetricCounter>>;
}
export interface RpcMetricComparisonRow {
    method: string;
    bucket: string;
    last24h: number;
    previous7dAverage: number;
    delta: number;
    deltaPercent: number | null;
}
export interface RpcMetricSourceDeltaRow {
    app: string;
    profile: string;
    method: string;
    bucket: string;
    last24h: number;
    previous7dAverage: number;
    delta: number;
    deltaPercent: number | null;
}
export interface RpcMetricComparison {
    generatedAtMs: number;
    baselineDays: number;
    methods: RpcMetricComparisonRow[];
    sources: RpcMetricSourceDeltaRow[];
}
export declare function recordRpcMetric(paths: RpcLimiterPaths, sample: RpcMetricSample, nowMs?: number, lockOptions?: lockfile.LockOptions): Promise<void>;
export declare function readMetrics(metricsFile: string, nowMs?: number): RpcMetricsState;
export declare function writeMetricsSync(metricsFile: string, metrics: RpcMetricsState): void;
export declare function buildMetricsComparison(metrics: RpcMetricsState, nowMs?: number, limit?: number): RpcMetricComparison;
export declare function formatMetricsComparison(report: RpcMetricComparison): string;
export declare function normalizeRpcMethod(input: string | undefined): string;
//# sourceMappingURL=metrics.d.ts.map