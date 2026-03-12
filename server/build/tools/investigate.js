import { z } from "zod";
import { resolveSubscription, queryResourceGraph, getResourceHealth, getActivityLogs, getMetrics, batchExecute, discoverWorkspaces, queryLogAnalytics, } from "../utils/azure-client.js";
import { correlateTimelines, detectMetricAnomalies, detectDiagnosticPatterns, detectTrends, } from "../utils/correlator.js";
import { getMetricConfig, getDependencyQueries } from "../utils/metric-config.js";
import { formatErrorSummary } from "../utils/formatters.js";
export function registerInvestigate(server) {
    server.tool("azdoctor_investigate", "Investigate a specific Azure resource or incident. Performs multi-signal correlation across Resource Health, Activity Logs, Metrics, and dependent resources to identify root cause.", {
        resource: z
            .string()
            .describe("Resource name or full Azure resource ID"),
        subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
        resourceGroup: z
            .string()
            .optional()
            .describe("Resource group name (helps resolve resource ID faster)"),
        timeframeHours: z
            .number()
            .default(24)
            .describe("How many hours back to investigate"),
        symptom: z
            .string()
            .optional()
            .describe('User-described symptom (e.g., "slow", "500 errors", "unreachable")'),
    }, async ({ resource, subscription: subParam, resourceGroup, timeframeHours, symptom, }) => {
        const subscription = await resolveSubscription(subParam);
        const errors = [];
        const allEvents = [];
        // 1. Resolve resource ID from name if needed
        let resourceId = resource;
        let resourceType = "Unknown";
        let resourceName = resource;
        let resolvedResourceGroup = resourceGroup;
        if (!resource.startsWith("/subscriptions/")) {
            const rgFilter = resourceGroup
                ? `| where resourceGroup =~ '${resourceGroup}'`
                : "";
            const resolveQuery = `Resources | where name =~ '${resource}' ${rgFilter} | project id, name, type, location, resourceGroup | take 1`;
            const resolved = await queryResourceGraph([subscription], resolveQuery);
            if (resolved.resources.length > 0) {
                const r = resolved.resources[0];
                resourceId = r.id ?? resource;
                resourceType = r.type ?? "Unknown";
                resourceName = r.name ?? resource;
                resolvedResourceGroup = r.resourceGroup ?? resourceGroup;
            }
            else if (resolved.error) {
                errors.push(resolved.error);
            }
        }
        else {
            // Parse resource ID for type, name, and resource group
            const parts = resource.split("/");
            resourceName = parts[parts.length - 1] ?? resource;
            const providerIdx = parts.indexOf("providers");
            if (providerIdx !== -1 && parts.length > providerIdx + 2) {
                resourceType = `${parts[providerIdx + 1]}/${parts[providerIdx + 2]}`;
            }
            const rgIdx = parts.indexOf("resourceGroups");
            if (rgIdx !== -1 && parts.length > rgIdx + 1) {
                resolvedResourceGroup = parts[rgIdx + 1];
            }
        }
        // 2-5: Gather signals in parallel
        const metricConfig = getMetricConfig(resourceType);
        const [healthResult, activityResult, metricsResult] = await Promise.all([
            // 2. Check Resource Health
            getResourceHealth(subscription, resourceId),
            // 3. Pull Activity Log for this resource
            getActivityLogs(subscription, timeframeHours, resourceId),
            // 4. Pull metrics (if we know the resource type)
            metricConfig
                ? getMetrics(resourceId, metricConfig.names, timeframeHours)
                : Promise.resolve({ data: null, error: undefined }),
        ]);
        // Process health result
        let currentHealth = "Unknown";
        if (healthResult.error) {
            errors.push(healthResult.error);
        }
        else if (healthResult.statuses.length > 0) {
            const status = healthResult.statuses[0];
            currentHealth =
                status.properties?.availabilityState ?? "Unknown";
            if (currentHealth !== "Available") {
                allEvents.push({
                    time: new Date().toISOString(),
                    event: `Health status: ${currentHealth} — ${status.properties?.summary ?? ""}`,
                    source: "ResourceHealth",
                    resource: resourceName,
                    severity: currentHealth === "Unavailable" ? "critical" : "warning",
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
        // Process metrics + detect trends
        const metricTrends = [];
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
                    // Detect trends for each metric
                    if (dataPoints.length >= 3) {
                        const trend = detectTrends(dataPoints, metric.name);
                        if (trend.trend !== "stable") {
                            metricTrends.push(trend);
                        }
                    }
                }
            }
        }
        // 6. Identify dependent resources via Resource Graph
        const dependentResources = [];
        if (resolvedResourceGroup) {
            const depQueries = getDependencyQueries(resourceType, resolvedResourceGroup);
            if (depQueries.length > 0) {
                const depResults = await Promise.all(depQueries.map((dq) => queryResourceGraph([subscription], dq.query)));
                // Collect all discovered dependent resources
                const allDeps = [];
                for (const result of depResults) {
                    for (const dep of result.resources) {
                        allDeps.push({
                            id: dep.id,
                            name: dep.name,
                            type: dep.type,
                        });
                    }
                    if (result.error) {
                        errors.push(result.error);
                    }
                }
                // Deduplicate by resource id
                const uniqueDeps = new Map();
                for (const dep of allDeps) {
                    if (!uniqueDeps.has(dep.id)) {
                        uniqueDeps.set(dep.id, dep);
                    }
                }
                // Check health of each discovered dependency with rate limiting (5 concurrent)
                const healthChecks = await batchExecute(Array.from(uniqueDeps.values()).map((dep) => async () => {
                    const depHealth = await getResourceHealth(subscription, dep.id);
                    const depState = depHealth.statuses[0]?.properties?.availabilityState ?? "Unknown";
                    return { dep, depState };
                }), 5);
                for (const { dep, depState } of healthChecks) {
                    dependentResources.push({
                        name: dep.name,
                        type: dep.type,
                        health: depState,
                        concern: depState !== "Available"
                            ? `${dep.name} is ${depState}`
                            : undefined,
                    });
                    if (depState !== "Available") {
                        allEvents.push({
                            time: new Date().toISOString(),
                            event: `Dependent resource ${dep.name} health: ${depState}`,
                            source: "ResourceHealth",
                            resource: dep.name,
                            severity: "warning",
                        });
                    }
                }
            }
        }
        // 7. Auto-discover Log Analytics workspaces and pull recent errors
        let logAnalyticsInsights = [];
        if (resolvedResourceGroup) {
            const wsResult = await discoverWorkspaces(subscription, resolvedResourceGroup);
            if (wsResult.workspaces.length > 0) {
                const wsInsights = await batchExecute(wsResult.workspaces.map((ws) => async () => {
                    const query = `union AppExceptions, AppRequests
| where TimeGenerated > ago(${timeframeHours}h)
| where Success == false or ExceptionType != ""
| summarize ErrorCount = count() by bin(TimeGenerated, 1h), OperationName
| order by ErrorCount desc
| take 5`;
                    const result = await queryLogAnalytics(ws.workspaceId, query, timeframeHours);
                    if (result.error) {
                        errors.push(result.error);
                        return null;
                    }
                    const errorCount = result.tables[0]?.rows?.length ?? 0;
                    const topErrors = result.tables[0]?.rows
                        ?.map((row) => String(row[2] ?? "Unknown"))
                        .filter((v, i, arr) => arr.indexOf(v) === i)
                        .slice(0, 5) ?? [];
                    return { workspace: ws.workspaceName, errorCount, topErrors };
                }), 3);
                logAnalyticsInsights = wsInsights.filter((r) => r !== null);
            }
        }
        // 8. Correlate timestamps across all signals
        const correlation = correlateTimelines(allEvents);
        // 9. Detect service-specific diagnostic patterns
        const diagnosticInsights = detectDiagnosticPatterns(allEvents, resourceType);
        // 10. Build investigation output
        const now = new Date();
        const windowStart = new Date(now.getTime() - timeframeHours * 60 * 60 * 1000);
        const errorSummary = formatErrorSummary(errors);
        const response = {
            resource: resourceName,
            resourceType,
            currentHealth,
            confidence: correlation.confidence,
            cascadingFailure: correlation.cascadingFailure,
            investigationWindow: `${windowStart.toISOString()} to ${now.toISOString()}`,
            symptom: symptom ?? null,
            timeline: correlation.timeline,
            likelyCause: correlation.likelyCause,
            earliestAnomaly: correlation.earliestAnomaly,
            precedingChanges: correlation.precedingChanges,
            dependentResources,
            diagnosticInsights: diagnosticInsights.length > 0 ? diagnosticInsights : undefined,
            metricTrends: metricTrends.length > 0 ? metricTrends : undefined,
            logAnalyticsInsights: logAnalyticsInsights.length > 0 ? logAnalyticsInsights : undefined,
            recommendedActions: buildRecommendations(currentHealth, correlation, dependentResources, symptom),
            diagnosticCoverage: errorSummary.message,
            permissionGaps: errorSummary.permissionGaps.length > 0 ? errorSummary.permissionGaps : undefined,
            errors: errors.length > 0 ? errors : undefined,
        };
        return {
            content: [
                { type: "text", text: JSON.stringify(response, null, 2) },
            ],
        };
    });
}
function buildRecommendations(currentHealth, correlation, dependentResources, symptom) {
    const actions = [];
    if (correlation.precedingChanges.length > 0) {
        const lastChange = correlation.precedingChanges[correlation.precedingChanges.length - 1];
        actions.push(`Review the change at ${lastChange.time}: "${lastChange.event}"${lastChange.actor ? ` (by ${lastChange.actor})` : ""}`);
        actions.push("Consider rolling back the change if immediate mitigation is needed.");
    }
    if (currentHealth === "Unavailable" || currentHealth === "Degraded") {
        actions.push("Check Azure Service Health for ongoing platform incidents in the resource's region.");
    }
    const unhealthyDeps = dependentResources.filter((d) => d.health !== "Available");
    if (unhealthyDeps.length > 0) {
        for (const dep of unhealthyDeps) {
            actions.push(`Investigate dependent resource ${dep.name} (${dep.type}) — currently ${dep.health}.`);
        }
    }
    if (actions.length === 0) {
        actions.push("No clear root cause identified from available signals.", "Search Microsoft Learn docs for troubleshooting guidance specific to this resource type and symptom.", "Check if there are Log Analytics workspaces with additional diagnostic data.");
    }
    return actions;
}
//# sourceMappingURL=investigate.js.map