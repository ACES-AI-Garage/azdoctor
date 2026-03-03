/**
 * Timestamp correlation logic for multi-signal diagnostic analysis.
 *
 * Given multiple event streams (health changes, activity log entries, metric anomalies),
 * finds events that co-occur within a configurable window and builds a causal timeline.
 */
/** Sources that represent anomalies (something went wrong) */
const ANOMALY_SOURCES = new Set(["ResourceHealth", "Metrics", "ServiceHealth"]);
/** Sources that represent changes (something was done) */
const CHANGE_SOURCES = new Set(["ActivityLog"]);
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
export function correlateTimelines(events, windowMinutes = 15) {
    if (events.length === 0) {
        return {
            timeline: [],
            earliestAnomaly: null,
            precedingChanges: [],
            likelyCause: "No diagnostic events were collected — insufficient data for correlation.",
        };
    }
    // 1. Sort all events by timestamp
    const sorted = [...events].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    // 2. Separate anomalies from changes
    const anomalies = sorted.filter((e) => ANOMALY_SOURCES.has(e.source));
    const changes = sorted.filter((e) => CHANGE_SOURCES.has(e.source));
    // 3. Find earliest anomaly
    const earliestAnomaly = anomalies.length > 0 ? anomalies[0] : null;
    if (!earliestAnomaly) {
        // No anomalies found — only changes exist
        if (changes.length > 0) {
            return {
                timeline: sorted,
                earliestAnomaly: null,
                precedingChanges: changes,
                likelyCause: `${changes.length} change(s) detected but no anomalies observed. Resources may be healthy, or monitoring data may be incomplete.`,
            };
        }
        return {
            timeline: sorted,
            earliestAnomaly: null,
            precedingChanges: [],
            likelyCause: "No anomalies or changes detected in the investigation window.",
        };
    }
    // 4. Find changes within the correlation window BEFORE the earliest anomaly
    const anomalyTime = new Date(earliestAnomaly.time).getTime();
    const windowMs = windowMinutes * 60 * 1000;
    const precedingChanges = changes.filter((c) => {
        const changeTime = new Date(c.time).getTime();
        return changeTime <= anomalyTime && anomalyTime - changeTime <= windowMs;
    });
    // 5. Build causal narrative
    const likelyCause = buildCausalNarrative(earliestAnomaly, precedingChanges, anomalies, windowMinutes);
    return { timeline: sorted, earliestAnomaly, precedingChanges, likelyCause };
}
function buildCausalNarrative(earliestAnomaly, precedingChanges, allAnomalies, windowMinutes) {
    const parts = [];
    if (precedingChanges.length > 0) {
        const change = precedingChanges[precedingChanges.length - 1]; // Most recent change before anomaly
        const changeTime = new Date(change.time);
        const anomalyTime = new Date(earliestAnomaly.time);
        const gapMinutes = Math.round((anomalyTime.getTime() - changeTime.getTime()) / 60000);
        parts.push(`A change at ${change.time} ("${change.event}"${change.actor ? ` by ${change.actor}` : ""}) preceded the first anomaly by ${gapMinutes} minute(s).`);
        parts.push(`First anomaly at ${earliestAnomaly.time}: "${earliestAnomaly.event}" (source: ${earliestAnomaly.source}).`);
        if (allAnomalies.length > 1) {
            parts.push(`${allAnomalies.length - 1} additional anomaly event(s) followed within the investigation window.`);
        }
        parts.push(`Correlation: the change likely triggered the observed anomalies (${gapMinutes}min gap, within ${windowMinutes}min correlation window).`);
    }
    else {
        parts.push(`First anomaly at ${earliestAnomaly.time}: "${earliestAnomaly.event}" (source: ${earliestAnomaly.source}).`);
        parts.push(`No preceding changes found within the ${windowMinutes}-minute correlation window.`);
        parts.push("This may indicate a platform-level issue, gradual resource exhaustion, or changes made outside the monitored scope.");
    }
    return parts.join(" ");
}
/**
 * Detect anomalies in a metric time series.
 * Returns events for values that exceed the threshold.
 */
export function detectMetricAnomalies(resourceId, metricName, dataPoints, thresholds) {
    const events = [];
    for (const dp of dataPoints) {
        const value = dp.maximum ?? dp.average;
        if (value === undefined)
            continue;
        if (value >= thresholds.criticalPct) {
            events.push({
                time: dp.timestamp,
                event: `${metricName} at ${value.toFixed(1)}% (critical threshold: ${thresholds.criticalPct}%)`,
                source: "Metrics",
                resource: resourceId,
                severity: "critical",
            });
        }
        else if (value >= thresholds.warningPct) {
            events.push({
                time: dp.timestamp,
                event: `${metricName} at ${value.toFixed(1)}% (warning threshold: ${thresholds.warningPct}%)`,
                source: "Metrics",
                resource: resourceId,
                severity: "warning",
            });
        }
    }
    return events;
}
//# sourceMappingURL=correlator.js.map