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
    confidence: "high" | "medium" | "low";
    cascadingFailure: boolean;
}
export interface EventCluster {
    startTime: string;
    endTime: string;
    events: DiagnosticEvent[];
    sources: string[];
    severity: "critical" | "warning" | "info";
}
export interface ChangeVelocityResult {
    highVelocityPeriods: Array<{
        startTime: string;
        endTime: string;
        changeCount: number;
        actors: string[];
    }>;
}
/**
 * Group events occurring within N minutes of each other into clusters.
 * Helps identify cascading failures.
 */
export declare function clusterEvents(events: DiagnosticEvent[], windowMinutes?: number): EventCluster[];
/**
 * Detect periods of unusually high change activity.
 */
export declare function detectChangeVelocity(events: DiagnosticEvent[], windowMinutes?: number, threshold?: number): ChangeVelocityResult;
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
export interface DiagnosticInsight {
    pattern: string;
    description: string;
    confidence: "high" | "medium" | "low";
    evidence: string[];
    recommendation: string;
}
/**
 * Detect service-specific diagnostic patterns from a set of events.
 * Returns matching patterns sorted by confidence (high first).
 */
export declare function detectDiagnosticPatterns(events: DiagnosticEvent[], resourceType: string): DiagnosticInsight[];
export interface TrendResult {
    metricName: string;
    trend: "rising" | "falling" | "stable" | "volatile";
    slope: number;
    dataPoints: number;
    description: string;
}
/**
 * Detect the trend in a metric time series using simple linear regression.
 * Returns the trend classification, normalized slope, and a human-readable description.
 */
export declare function detectTrends(dataPoints: Array<{
    timestamp: string;
    average?: number;
    maximum?: number;
}>, metricName: string): TrendResult;
//# sourceMappingURL=correlator.d.ts.map