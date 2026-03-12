import { z } from "zod";
import { resolveSubscription, queryResourceGraph, getResourceHealth, getActivityLogs, getMetrics, } from "../utils/azure-client.js";
import { correlateTimelines, detectMetricAnomalies, } from "../utils/correlator.js";
import { getMetricConfig } from "../utils/metric-config.js";
export function registerPlayback(server) {
    server.tool("azdoctor_playback", "Replay an incident timeline event-by-event in chronological order. Shows what happened, when, and provides context for each event — useful for post-incident learning and reviews.", {
        resource: z.string().describe("Resource name or full Azure resource ID"),
        subscription: z.string().optional(),
        startTime: z.string().describe("ISO timestamp for playback start"),
        endTime: z.string().optional().describe("ISO timestamp for playback end (defaults to now)"),
        includeContext: z.boolean().default(true).describe("Include explanatory context for each event"),
    }, async ({ resource, subscription: subParam, startTime, endTime, includeContext }) => {
        const subscription = await resolveSubscription(subParam);
        const errors = [];
        const allEvents = [];
        // 1. Resolve resource
        let resourceId = resource;
        let resourceType = "Unknown";
        let resourceName = resource;
        if (!resource.startsWith("/subscriptions/")) {
            const resolveQuery = `Resources | where name =~ '${resource}' | project id, name, type, location, resourceGroup | take 1`;
            const resolved = await queryResourceGraph([subscription], resolveQuery);
            if (resolved.resources.length > 0) {
                const r = resolved.resources[0];
                resourceId = r.id ?? resource;
                resourceType = r.type ?? "Unknown";
                resourceName = r.name ?? resource;
            }
            else if (resolved.error) {
                errors.push(resolved.error);
            }
        }
        else {
            const parts = resource.split("/");
            resourceName = parts[parts.length - 1] ?? resource;
            const providerIdx = parts.indexOf("providers");
            if (providerIdx !== -1 && parts.length > providerIdx + 2) {
                resourceType = `${parts[providerIdx + 1]}/${parts[providerIdx + 2]}`;
            }
        }
        // 2. Calculate hours back from startTime
        const startDate = new Date(startTime);
        const endDate = endTime ? new Date(endTime) : new Date();
        const hoursBack = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (60 * 60 * 1000)));
        // 3. Gather signals in parallel
        const metricConfig = getMetricConfig(resourceType);
        const [healthResult, activityResult, metricsResult] = await Promise.all([
            getResourceHealth(subscription, resourceId),
            getActivityLogs(subscription, hoursBack, resourceId),
            metricConfig
                ? getMetrics(resourceId, metricConfig.names, hoursBack)
                : Promise.resolve({ data: null, error: undefined }),
        ]);
        // Process health result
        if (healthResult.error) {
            errors.push(healthResult.error);
        }
        else if (healthResult.statuses.length > 0) {
            const status = healthResult.statuses[0];
            const availState = status.properties?.availabilityState ?? "Unknown";
            if (availState !== "Available") {
                allEvents.push({
                    time: new Date().toISOString(),
                    event: `Health status: ${availState} — ${status.properties?.summary ?? ""}`,
                    source: "ResourceHealth",
                    resource: resourceName,
                    severity: availState === "Unavailable" ? "critical" : "warning",
                });
            }
        }
        // Process activity log
        if (activityResult.error) {
            errors.push(activityResult.error);
        }
        else {
            for (const event of activityResult.events) {
                const opName = event.operationName?.localizedValue ??
                    event.operationName?.value ??
                    "Unknown operation";
                const status = event.status?.value ?? "";
                const timestamp = event.eventTimestamp?.toISOString() ?? new Date().toISOString();
                allEvents.push({
                    time: timestamp,
                    event: `${opName} (${status})`,
                    source: "ActivityLog",
                    resource: resourceName,
                    actor: event.caller,
                    severity: status === "Failed" ? "warning" : "info",
                });
            }
        }
        // Process metrics
        if (metricsResult.error) {
            errors.push(metricsResult.error);
        }
        else if (metricsResult.data && metricConfig) {
            for (const metric of metricsResult.data.metrics) {
                for (const ts of metric.timeseries) {
                    if (!ts.data)
                        continue;
                    const dataPoints = ts.data
                        .filter((dp) => dp.average !== undefined || dp.maximum !== undefined)
                        .map((dp) => ({
                        timestamp: dp.timeStamp?.toISOString() ??
                            new Date().toISOString(),
                        average: dp.average ?? undefined,
                        maximum: dp.maximum ?? undefined,
                    }));
                    const anomalies = detectMetricAnomalies(resourceId, metric.name, dataPoints, {
                        warningPct: metricConfig.warningPct,
                        criticalPct: metricConfig.criticalPct,
                    });
                    allEvents.push(...anomalies);
                }
            }
        }
        // 4. Correlate timelines
        const correlation = correlateTimelines(allEvents);
        // Filter events to the playback window
        const windowEvents = correlation.timeline.filter((e) => {
            const t = new Date(e.time).getTime();
            return t >= startDate.getTime() && t <= endDate.getTime();
        });
        // 5. Assign phase markers and generate context
        const anomalyEvents = windowEvents.filter((e) => e.source === "ResourceHealth" || e.source === "Metrics" || e.source === "ServiceHealth");
        const firstAnomalyTime = anomalyEvents.length > 0
            ? new Date(anomalyEvents[0].time).getTime()
            : null;
        const lastAnomalyTime = anomalyEvents.length > 0
            ? new Date(anomalyEvents[anomalyEvents.length - 1].time).getTime()
            : null;
        // Find resolution: first change event after the last anomaly
        let resolutionTime = null;
        if (lastAnomalyTime !== null) {
            const postAnomalyChanges = windowEvents.filter((e) => {
                const t = new Date(e.time).getTime();
                return t > lastAnomalyTime && e.source === "ActivityLog";
            });
            if (postAnomalyChanges.length > 0) {
                resolutionTime = new Date(postAnomalyChanges[0].time).getTime();
            }
        }
        const timeline = windowEvents.map((e) => {
            const t = new Date(e.time).getTime();
            let phaseMarker;
            if (firstAnomalyTime === null) {
                phaseMarker = "pre-incident";
            }
            else if (t < firstAnomalyTime) {
                phaseMarker = "pre-incident";
            }
            else if (t === firstAnomalyTime && anomalyEvents[0] === e) {
                phaseMarker = "incident-start";
            }
            else if (lastAnomalyTime !== null && t <= lastAnomalyTime) {
                phaseMarker = "during-incident";
            }
            else if (resolutionTime !== null && t <= resolutionTime && e.source === "ActivityLog") {
                phaseMarker = "resolution";
            }
            else if (lastAnomalyTime !== null && t > lastAnomalyTime) {
                phaseMarker = "post-incident";
            }
            else {
                phaseMarker = "during-incident";
            }
            const entry = {
                timestamp: e.time,
                event: e.event,
                source: e.source,
                actor: e.actor,
                severity: e.severity,
                phaseMarker,
            };
            if (includeContext) {
                entry.context = generateContext(e);
            }
            return entry;
        });
        // Count phases
        const preIncidentCount = timeline.filter((e) => e.phaseMarker === "pre-incident").length;
        const duringIncidentCount = timeline.filter((e) => e.phaseMarker === "during-incident").length;
        const postIncidentCount = timeline.filter((e) => e.phaseMarker === "post-incident").length;
        const incidentStartTimestamp = firstAnomalyTime
            ? new Date(firstAnomalyTime).toISOString()
            : null;
        const resolutionTimestamp = resolutionTime
            ? new Date(resolutionTime).toISOString()
            : null;
        // Build summary
        const durationMs = endDate.getTime() - startDate.getTime();
        const durationHours = Math.floor(durationMs / (60 * 60 * 1000));
        const durationMinutes = Math.floor((durationMs % (60 * 60 * 1000)) / (60 * 1000));
        const durationStr = durationHours > 0
            ? `${durationHours}h ${durationMinutes}m`
            : `${durationMinutes}m`;
        let summary = `${timeline.length} events over ${durationStr}.`;
        if (incidentStartTimestamp) {
            const startUtc = incidentStartTimestamp.replace("T", " ").replace(/\.\d+Z$/, " UTC");
            summary += ` Incident started at ${startUtc}`;
            if (resolutionTimestamp) {
                const resolveUtc = resolutionTimestamp.replace("T", " ").replace(/\.\d+Z$/, " UTC");
                summary += `, resolved at ${resolveUtc}.`;
            }
            else {
                summary += `, no clear resolution detected.`;
            }
        }
        else {
            summary += " No anomalies detected in the playback window.";
        }
        const response = {
            resource: resourceName,
            playbackWindow: `${startDate.toISOString()} to ${endDate.toISOString()}`,
            totalEvents: timeline.length,
            phases: {
                preIncident: preIncidentCount,
                incidentStart: incidentStartTimestamp,
                duringIncident: duringIncidentCount,
                resolution: resolutionTimestamp,
                postIncident: postIncidentCount,
            },
            timeline,
            summary,
            errors: errors.length > 0 ? errors : undefined,
        };
        return {
            content: [
                { type: "text", text: JSON.stringify(response, null, 2) },
            ],
        };
    });
}
function generateContext(event) {
    const e = event.event.toLowerCase();
    if (event.source === "ActivityLog") {
        if (e.includes("write")) {
            return "A configuration change was made to the resource.";
        }
        if (e.includes("delete")) {
            return "A resource or component was deleted.";
        }
        if (e.includes("failed")) {
            return "This operation failed — check if it's related to the incident.";
        }
        return "An activity log event was recorded.";
    }
    if (event.source === "ResourceHealth") {
        if (e.includes("unavailable")) {
            return "Azure detected the resource as unavailable. This typically means the resource cannot serve requests.";
        }
        if (e.includes("degraded")) {
            return "The resource is experiencing reduced functionality or performance.";
        }
        return "A resource health status change was detected.";
    }
    if (event.source === "Metrics") {
        if (event.severity === "critical") {
            return "This metric exceeded the critical threshold, indicating severe resource pressure.";
        }
        if (event.severity === "warning") {
            return "This metric is elevated and approaching critical levels.";
        }
        return "A metric anomaly was detected.";
    }
    if (event.source === "ServiceHealth") {
        return "An Azure platform event was reported that may affect this resource.";
    }
    return "An event was recorded.";
}
//# sourceMappingURL=playback.js.map