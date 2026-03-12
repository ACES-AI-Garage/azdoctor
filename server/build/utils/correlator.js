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
const SEVERITY_RANK = {
    critical: 3,
    warning: 2,
    info: 1,
};
/**
 * Group events occurring within N minutes of each other into clusters.
 * Helps identify cascading failures.
 */
export function clusterEvents(events, windowMinutes = 5) {
    if (events.length === 0)
        return [];
    const sorted = [...events].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    const windowMs = windowMinutes * 60 * 1000;
    const clusters = [];
    let currentCluster = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const lastInCluster = currentCluster[currentCluster.length - 1];
        const gap = new Date(sorted[i].time).getTime() -
            new Date(lastInCluster.time).getTime();
        if (gap <= windowMs) {
            currentCluster.push(sorted[i]);
        }
        else {
            clusters.push(buildCluster(currentCluster));
            currentCluster = [sorted[i]];
        }
    }
    clusters.push(buildCluster(currentCluster));
    return clusters;
}
function buildCluster(events) {
    const sources = [...new Set(events.map((e) => e.source))];
    const highestSeverity = events.reduce((max, e) => {
        const rank = SEVERITY_RANK[e.severity ?? "info"] ?? 1;
        return rank > (SEVERITY_RANK[max] ?? 1) ? e.severity : max;
    }, "info");
    return {
        startTime: events[0].time,
        endTime: events[events.length - 1].time,
        events,
        sources,
        severity: highestSeverity,
    };
}
/**
 * Detect periods of unusually high change activity.
 */
export function detectChangeVelocity(events, windowMinutes = 30, threshold = 5) {
    const changes = events
        .filter((e) => CHANGE_SOURCES.has(e.source))
        .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    const windowMs = windowMinutes * 60 * 1000;
    const highVelocityPeriods = [];
    if (changes.length < threshold) {
        return { highVelocityPeriods };
    }
    // Sliding window approach
    let windowStart = 0;
    for (let windowEnd = 0; windowEnd < changes.length; windowEnd++) {
        const endTime = new Date(changes[windowEnd].time).getTime();
        // Advance start to keep within window
        while (windowStart < windowEnd &&
            endTime - new Date(changes[windowStart].time).getTime() > windowMs) {
            windowStart++;
        }
        const count = windowEnd - windowStart + 1;
        if (count >= threshold) {
            const periodEvents = changes.slice(windowStart, windowEnd + 1);
            const actors = [
                ...new Set(periodEvents
                    .map((e) => e.actor)
                    .filter((a) => a !== undefined)),
            ];
            // Avoid adding overlapping periods — check if the last added period overlaps
            const last = highVelocityPeriods[highVelocityPeriods.length - 1];
            if (last &&
                new Date(last.endTime).getTime() >=
                    new Date(changes[windowStart].time).getTime()) {
                // Extend the existing period
                last.endTime = changes[windowEnd].time;
                last.changeCount = Math.max(last.changeCount, count);
                for (const actor of actors) {
                    if (!last.actors.includes(actor)) {
                        last.actors.push(actor);
                    }
                }
            }
            else {
                highVelocityPeriods.push({
                    startTime: changes[windowStart].time,
                    endTime: changes[windowEnd].time,
                    changeCount: count,
                    actors,
                });
            }
        }
    }
    return { highVelocityPeriods };
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
export function correlateTimelines(events, windowMinutes = 15) {
    if (events.length === 0) {
        return {
            timeline: [],
            earliestAnomaly: null,
            precedingChanges: [],
            likelyCause: "No diagnostic events were collected — insufficient data for correlation.",
            confidence: "low",
            cascadingFailure: false,
        };
    }
    // 1. Sort all events by timestamp
    const sorted = [...events].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    // 2. Separate anomalies from changes
    const anomalies = sorted.filter((e) => ANOMALY_SOURCES.has(e.source));
    const changes = sorted.filter((e) => CHANGE_SOURCES.has(e.source));
    // 3. Detect cascading failures using clustering
    const anomalyClusters = clusterEvents(anomalies, 5);
    const cascadingFailure = anomalyClusters.some((cluster) => cluster.events.length >= 3);
    // 4. Find earliest anomaly
    const earliestAnomaly = anomalies.length > 0 ? anomalies[0] : null;
    if (!earliestAnomaly) {
        // No anomalies found — only changes exist
        const confidence = changes.length > 0 ? "medium" : "low";
        if (changes.length > 0) {
            return {
                timeline: sorted,
                earliestAnomaly: null,
                precedingChanges: changes,
                likelyCause: `${changes.length} change(s) detected but no anomalies observed. Resources may be healthy, or monitoring data may be incomplete.`,
                confidence,
                cascadingFailure: false,
            };
        }
        return {
            timeline: sorted,
            earliestAnomaly: null,
            precedingChanges: [],
            likelyCause: "No anomalies or changes detected in the investigation window.",
            confidence,
            cascadingFailure: false,
        };
    }
    // 5. Find changes within the correlation window BEFORE the earliest anomaly
    const anomalyTime = new Date(earliestAnomaly.time).getTime();
    const windowMs = windowMinutes * 60 * 1000;
    const precedingChanges = changes.filter((c) => {
        const changeTime = new Date(c.time).getTime();
        return changeTime <= anomalyTime && anomalyTime - changeTime <= windowMs;
    });
    // 6. Determine confidence
    const hasAnomalies = anomalies.length > 0;
    const hasPrecedingChanges = precedingChanges.length > 0;
    let confidence;
    if (hasPrecedingChanges && hasAnomalies) {
        confidence = "high";
    }
    else if (hasAnomalies || hasPrecedingChanges) {
        confidence = "medium";
    }
    else {
        confidence = "low";
    }
    // 7. Build causal narrative
    const likelyCause = buildCausalNarrative(earliestAnomaly, precedingChanges, anomalies, windowMinutes, cascadingFailure);
    return {
        timeline: sorted,
        earliestAnomaly,
        precedingChanges,
        likelyCause,
        confidence,
        cascadingFailure,
    };
}
function buildCausalNarrative(earliestAnomaly, precedingChanges, allAnomalies, windowMinutes, cascadingFailure) {
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
    if (cascadingFailure) {
        parts.push("Cascading failure pattern detected: 3+ anomalies clustered within 5 minutes, suggesting a chain reaction across resources.");
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
/**
 * Detect service-specific diagnostic patterns from a set of events.
 * Returns matching patterns sorted by confidence (high first).
 */
export function detectDiagnosticPatterns(events, resourceType) {
    const insights = [];
    const normalizedType = resourceType.toLowerCase();
    // Helper: check if any event string contains a substring (case-insensitive)
    const findEvents = (substring) => events.filter((e) => e.event.toLowerCase().includes(substring.toLowerCase()));
    const findEventsBySeverity = (substring, ...severities) => events.filter((e) => e.event.toLowerCase().includes(substring.toLowerCase()) &&
        severities.includes(e.severity ?? "info"));
    const findEventsBySource = (source) => events.filter((e) => e.source === source);
    // Helper: check if two events are within N minutes of each other
    const withinMinutes = (a, b, minutes) => {
        const diff = Math.abs(new Date(a.time).getTime() - new Date(b.time).getTime());
        return diff <= minutes * 60 * 1000;
    };
    // Helper: check if any pair from two arrays are within N minutes
    const anyWithinMinutes = (groupA, groupB, minutes) => {
        for (const a of groupA) {
            for (const b of groupB) {
                if (withinMinutes(a, b, minutes))
                    return true;
            }
        }
        return false;
    };
    // --- App Service patterns ---
    if (normalizedType === "microsoft.web/sites") {
        // bad_deployment
        const deployments = findEventsBySource("ActivityLog").filter((e) => e.event.toLowerCase().includes("deploy") ||
            e.event.toLowerCase().includes("restart") ||
            e.event.toLowerCase().includes("swap") ||
            e.event.toLowerCase().includes("write"));
        const http5xx = findEvents("Http5xx");
        const httpResponseTime = findEvents("HttpResponseTime");
        const errorSignals = [...http5xx, ...httpResponseTime];
        if (deployments.length > 0 &&
            errorSignals.length > 0 &&
            anyWithinMinutes(deployments, errorSignals, 15)) {
            insights.push({
                pattern: "bad_deployment",
                description: "A deployment or configuration change occurred shortly before HTTP errors or response time degradation.",
                confidence: "high",
                evidence: [
                    ...deployments.map((e) => `[ActivityLog] ${e.event} at ${e.time}`),
                    ...errorSignals.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                ],
                recommendation: "Recent deployment likely caused errors. Consider rolling back.",
            });
        }
        // memory_exhaustion
        const memoryCritical = findEventsBySeverity("MemoryPercentage", "critical");
        const httpQueue = findEvents("HttpQueueLength");
        const httpRespWarnCrit = findEventsBySeverity("HttpResponseTime", "warning", "critical");
        const queueOrResp = [...httpQueue, ...httpRespWarnCrit];
        if (memoryCritical.length > 0 && queueOrResp.length > 0) {
            insights.push({
                pattern: "memory_exhaustion",
                description: "High memory usage is causing request queuing and response time degradation.",
                confidence: "high",
                evidence: [
                    ...memoryCritical.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                    ...queueOrResp.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                ],
                recommendation: "Memory pressure causing request queuing. Scale up the App Service Plan or optimize memory usage.",
            });
        }
        // cpu_saturation
        const cpuCritical = findEventsBySeverity("CpuPercentage", "critical");
        if (cpuCritical.length > 0 && httpRespWarnCrit.length > 0) {
            insights.push({
                pattern: "cpu_saturation",
                description: "High CPU usage is degrading HTTP response times.",
                confidence: "high",
                evidence: [
                    ...cpuCritical.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                    ...httpRespWarnCrit.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                ],
                recommendation: "CPU saturation degrading response times. Scale out or optimize CPU-intensive operations.",
            });
        }
        // health_check_failure
        const healthCheck = findEvents("HealthCheckStatus");
        if (healthCheck.length > 0) {
            insights.push({
                pattern: "health_check_failure",
                description: "The health check endpoint is reporting failures.",
                confidence: "medium",
                evidence: healthCheck.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                recommendation: "Health check endpoint is failing. Review the health check path configuration and application startup.",
            });
        }
    }
    // --- SQL Database patterns ---
    if (normalizedType === "microsoft.sql/servers/databases") {
        // dtu_exhaustion
        const dtuCritical = findEventsBySeverity("dtu_consumption_percent", "critical");
        if (dtuCritical.length > 0) {
            insights.push({
                pattern: "dtu_exhaustion",
                description: "Database DTU consumption has reached critical levels.",
                confidence: "high",
                evidence: dtuCritical.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                recommendation: "DTU capacity exhausted. Scale up the database tier or optimize queries.",
            });
        }
        // connection_storm
        const connFailed = findEventsBySeverity("connection_failed", "warning", "critical");
        if (connFailed.length > 0) {
            insights.push({
                pattern: "connection_storm",
                description: "Database connection failures are occurring.",
                confidence: "high",
                evidence: connFailed.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                recommendation: "Connection failures detected. Check connection pool settings and max connection limits.",
            });
        }
        // deadlock_storm
        const deadlocks = findEventsBySeverity("deadlock", "warning", "critical");
        const dtuWarning = findEventsBySeverity("dtu_consumption_percent", "warning");
        if (deadlocks.length > 0 && dtuWarning.length > 0) {
            insights.push({
                pattern: "deadlock_storm",
                description: "Deadlocks are occurring alongside elevated DTU consumption.",
                confidence: "high",
                evidence: [
                    ...deadlocks.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                    ...dtuWarning.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                ],
                recommendation: "Deadlocks under load. Review transaction isolation levels and query patterns.",
            });
        }
    }
    // --- VM patterns ---
    if (normalizedType === "microsoft.compute/virtualmachines") {
        // disk_bottleneck
        const diskQueue = findEventsBySeverity("OS Disk Queue Depth", "critical");
        if (diskQueue.length > 0) {
            insights.push({
                pattern: "disk_bottleneck",
                description: "OS disk I/O queue depth has reached critical levels.",
                confidence: "high",
                evidence: diskQueue.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                recommendation: "Disk I/O bottleneck. Consider Premium SSD or Ultra Disk, or distribute I/O across multiple disks.",
            });
        }
        // network_saturation
        const networkIn = findEventsBySeverity("Network In", "critical");
        const networkOut = findEventsBySeverity("Network Out", "critical");
        const networkEvents = [...networkIn, ...networkOut];
        if (networkEvents.length > 0) {
            insights.push({
                pattern: "network_saturation",
                description: "Network bandwidth has reached critical levels.",
                confidence: "high",
                evidence: networkEvents.map((e) => `[Metrics] ${e.event} at ${e.time}`),
                recommendation: "Network bandwidth saturated. Consider accelerated networking or scaling to a larger VM size.",
            });
        }
    }
    // --- Generic patterns (any resource type) ---
    // platform_incident: ResourceHealth Unavailable + no preceding ActivityLog changes
    const healthUnavailable = events.filter((e) => e.source === "ResourceHealth" &&
        e.event.toLowerCase().includes("unavailable"));
    const activityLogEvents = findEventsBySource("ActivityLog");
    if (healthUnavailable.length > 0) {
        // Check that there are no ActivityLog changes preceding any unavailable event
        const hasPrecedingChange = healthUnavailable.some((h) => {
            const hTime = new Date(h.time).getTime();
            return activityLogEvents.some((a) => {
                const aTime = new Date(a.time).getTime();
                return aTime < hTime && hTime - aTime <= 15 * 60 * 1000;
            });
        });
        if (!hasPrecedingChange) {
            insights.push({
                pattern: "platform_incident",
                description: "Resource became unavailable with no preceding configuration changes.",
                confidence: "medium",
                evidence: healthUnavailable.map((e) => `[ResourceHealth] ${e.event} at ${e.time}`),
                recommendation: "Platform-level incident suspected. Check Azure Service Health.",
            });
        }
    }
    // rapid_config_changes: 5+ ActivityLog events within 10 minutes
    if (activityLogEvents.length >= 5) {
        const sorted = [...activityLogEvents].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        const tenMinMs = 10 * 60 * 1000;
        let found = false;
        for (let i = 0; i <= sorted.length - 5 && !found; i++) {
            const startTime = new Date(sorted[i].time).getTime();
            const endTime = new Date(sorted[i + 4].time).getTime();
            if (endTime - startTime <= tenMinMs) {
                found = true;
                insights.push({
                    pattern: "rapid_config_changes",
                    description: "Multiple configuration changes occurred in a short time window.",
                    confidence: "medium",
                    evidence: sorted.map((e) => `[ActivityLog] ${e.event} at ${e.time}`),
                    recommendation: "Rapid configuration changes detected. This may indicate automated remediation loops or deployment issues.",
                });
            }
        }
    }
    // Sort by confidence: high first, then medium, then low
    const confidenceOrder = {
        high: 0,
        medium: 1,
        low: 2,
    };
    insights.sort((a, b) => (confidenceOrder[a.confidence] ?? 2) -
        (confidenceOrder[b.confidence] ?? 2));
    return insights;
}
/**
 * Detect the trend in a metric time series using simple linear regression.
 * Returns the trend classification, normalized slope, and a human-readable description.
 */
export function detectTrends(dataPoints, metricName) {
    const values = [];
    for (const dp of dataPoints) {
        const v = dp.average ?? dp.maximum;
        if (v !== undefined) {
            values.push(v);
        }
    }
    const n = values.length;
    if (n < 2) {
        return {
            metricName,
            trend: "stable",
            slope: 0,
            dataPoints: n,
            description: `${metricName} has insufficient data points for trend analysis.`,
        };
    }
    // Simple linear regression: y = a + b*x, where x = index
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += values[i];
        sumXY += i * values[i];
        sumX2 += i * i;
    }
    const denominator = n * sumX2 - sumX * sumX;
    const rawSlope = denominator !== 0 ? (n * sumXY - sumX * sumY) / denominator : 0;
    const intercept = (sumY - rawSlope * sumX) / n;
    // Normalize slope to -1..1 based on the data range
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const dataRange = maxVal - minVal;
    let normalizedSlope;
    if (dataRange === 0) {
        normalizedSlope = 0;
    }
    else {
        // The total predicted change over the series is rawSlope * (n - 1).
        // Normalize by the data range.
        const totalChange = rawSlope * (n - 1);
        normalizedSlope = Math.max(-1, Math.min(1, totalChange / dataRange));
    }
    // Calculate R² (coefficient of determination)
    const meanY = sumY / n;
    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < n; i++) {
        const predicted = intercept + rawSlope * i;
        ssRes += (values[i] - predicted) ** 2;
        ssTot += (values[i] - meanY) ** 2;
    }
    const rSquared = ssTot !== 0 ? 1 - ssRes / ssTot : 1;
    // Classify the trend
    let trend;
    if (Math.abs(normalizedSlope) < 0.1) {
        trend = "stable";
    }
    else if (rSquared < 0.3) {
        trend = "volatile";
    }
    else if (normalizedSlope > 0) {
        trend = "rising";
    }
    else {
        trend = "falling";
    }
    // Build human-readable description
    let description;
    switch (trend) {
        case "rising":
            description = `${metricName} is rising steadily over the observed period.`;
            break;
        case "falling":
            description = `${metricName} is falling steadily over the observed period.`;
            break;
        case "stable":
            description = `${metricName} is stable over the observed period.`;
            break;
        case "volatile":
            description = `${metricName} is volatile with no clear trend over the observed period.`;
            break;
    }
    return {
        metricName,
        trend,
        slope: Math.round(normalizedSlope * 1000) / 1000, // round to 3 decimal places
        dataPoints: n,
        description,
    };
}
//# sourceMappingURL=correlator.js.map