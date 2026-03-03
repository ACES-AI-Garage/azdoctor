/**
 * Timestamp correlation logic for multi-signal diagnostic analysis.
 *
 * Given multiple event streams (health changes, activity log entries, metric anomalies),
 * finds events that co-occur within a configurable window and builds a causal timeline.
 */
export interface DiagnosticEvent {
    time: string;
    event: string;
    source: "ActivityLog" | "ResourceHealth" | "Metrics" | "ServiceHealth";
    resource?: string;
    actor?: string;
    severity?: "critical" | "warning" | "info";
}
export interface CorrelationResult {
    timeline: DiagnosticEvent[];
    earliestAnomaly: DiagnosticEvent | null;
    precedingChanges: DiagnosticEvent[];
    likelyCause: string;
}
/**
 * Correlate events across multiple signal streams to build a causal timeline.
 *
 * Algorithm:
 * 1. Sort all events by timestamp
 * 2. Identify anomaly events (health changes, metric spikes, service issues)
 * 3. Find the earliest anomaly
 * 4. Find changes (deployments, config changes) that preceded the earliest anomaly
 *    within the correlation window
 * 5. Build a causal narrative
 */
export declare function correlateTimelines(events: DiagnosticEvent[], windowMinutes?: number): CorrelationResult;
/**
 * Detect anomalies in a metric time series.
 * Returns events for values that exceed the threshold.
 */
export declare function detectMetricAnomalies(resourceId: string, metricName: string, dataPoints: Array<{
    timestamp: string;
    average?: number;
    maximum?: number;
}>, thresholds: {
    warningPct: number;
    criticalPct: number;
}): DiagnosticEvent[];
//# sourceMappingURL=correlator.d.ts.map