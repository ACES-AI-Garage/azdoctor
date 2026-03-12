import { z } from "zod";
import { resolveSubscription, queryResourceGraph, getResourceHealth, getActivityLogs, getMetrics, batchExecute, discoverWorkspaces, } from "../utils/azure-client.js";
import { correlateTimelines, detectMetricAnomalies, detectDiagnosticPatterns, detectTrends, } from "../utils/correlator.js";
import { getMetricConfig, getDependencyQueries } from "../utils/metric-config.js";
import { formatErrorSummary, renderTopology } from "../utils/formatters.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// ─── Alert Templates ────────────────────────────────────────────────
const TRIAGE_ALERT_TEMPLATES = {
    "microsoft.web/sites": [
        { name: "Error Rate", metric: "Http5xx", threshold: 10, description: "HTTP 5xx > 10 in 5min" },
        { name: "High CPU", metric: "CpuPercentage", threshold: 85, description: "CPU > 85% for 5min" },
        { name: "High Memory", metric: "MemoryPercentage", threshold: 85, description: "Memory > 85% for 5min" },
        { name: "Slow Response", metric: "HttpResponseTime", threshold: 5, description: "Avg response > 5s" },
    ],
    "microsoft.sql/servers/databases": [
        { name: "DTU Saturation", metric: "dtu_consumption_percent", threshold: 90, description: "DTU > 90% for 5min" },
        { name: "Connection Failures", metric: "connection_failed", threshold: 5, description: "Failed connections > 5 in 5min" },
        { name: "Deadlocks", metric: "deadlock", threshold: 1, description: "Any deadlock detected" },
    ],
    "microsoft.compute/virtualmachines": [
        { name: "High CPU", metric: "Percentage CPU", threshold: 90, description: "CPU > 90% for 5min" },
        { name: "Disk I/O", metric: "OS Disk Queue Depth", threshold: 10, description: "Disk queue > 10" },
    ],
    "microsoft.cache/redis": [
        { name: "Server Load", metric: "serverLoad", threshold: 80, description: "Server load > 80%" },
        { name: "Memory Usage", metric: "usedmemorypercentage", threshold: 85, description: "Memory > 85%" },
    ],
};
// ─── Helpers ────────────────────────────────────────────────────────
const JOURNAL_DIR = join(homedir(), ".azdoctor", "journal");
function ensureJournalDir() {
    mkdirSync(JOURNAL_DIR, { recursive: true });
}
function formatDateForFilename(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function sanitizeResourceName(resource) {
    return resource
        .replace(/[/\\:*?"<>|]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase();
}
function computeBaseline(dataPoints, metricName) {
    const values = [];
    for (const dp of dataPoints) {
        const v = dp.average ?? dp.maximum;
        if (v !== undefined)
            values.push(v);
    }
    if (values.length < 2)
        return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const current = values[values.length - 1];
    const zScore = stdDev !== 0 ? (current - mean) / stdDev : 0;
    let status;
    if (Math.abs(zScore) < 1) {
        status = "normal";
    }
    else if (Math.abs(zScore) < 2) {
        status = "elevated";
    }
    else {
        status = "anomalous";
    }
    return {
        metric: metricName,
        current: Math.round(current * 100) / 100,
        mean: Math.round(mean * 100) / 100,
        stdDev: Math.round(stdDev * 100) / 100,
        zScore: Math.round(zScore * 100) / 100,
        status,
    };
}
function buildRemediationSuggestions(insights, currentHealth, dependentResources) {
    const suggestions = [];
    for (const insight of insights) {
        if (insight.recommendation && !suggestions.includes(insight.recommendation)) {
            suggestions.push(insight.recommendation);
        }
    }
    if (currentHealth === "Unavailable" || currentHealth === "Degraded") {
        suggestions.push("Check Azure Service Health for ongoing platform incidents in the resource's region.");
    }
    const unhealthyDeps = dependentResources.filter((d) => d.health !== "Available");
    for (const dep of unhealthyDeps) {
        suggestions.push(`Investigate dependent resource ${dep.name} (${dep.type}) — currently ${dep.health}.`);
    }
    if (suggestions.length === 0) {
        suggestions.push("No clear root cause identified from available signals.", "Search Microsoft Learn docs for troubleshooting guidance specific to this resource type.");
    }
    return suggestions;
}
function buildJournalMarkdown(report) {
    const insightsBullets = report.diagnosticInsights.length > 0
        ? report.diagnosticInsights
            .map((i) => `- **${i.pattern}** (${i.confidence}): ${i.description}`)
            .join("\n")
        : "- No diagnostic patterns detected.";
    const trendsBullets = report.metricTrends.length > 0
        ? report.metricTrends.map((t) => `- ${t.description}`).join("\n")
        : "- All monitored metrics are stable.";
    const baselineRows = report.baseline.metrics.length > 0
        ? "| Metric | Current | Mean | StdDev | Z-Score | Status |\n|--------|---------|------|--------|---------|--------|\n" +
            report.baseline.metrics
                .map((m) => `| ${m.metric} | ${m.current} | ${m.mean} | ${m.stdDev} | ${m.zScore} | ${m.status} |`)
                .join("\n")
        : "No baseline metrics available.";
    const alertsBullets = report.alertRecommendations.length > 0
        ? report.alertRecommendations
            .map((a) => `- **${a.name}**: ${a.description} (metric: ${a.metric}, threshold: ${a.threshold})`)
            .join("\n")
        : "- No alert recommendations for this resource type.";
    return `# Triage Report: ${report.resource}
**Date:** ${report.timestamp}
**Type:** ${report.resourceType}
**Health:** ${report.currentHealth}
**Confidence:** ${report.confidence}

## Root Cause
${report.likelyCause}

## Diagnostic Insights
${insightsBullets}

## Metric Trends
${trendsBullets}

## Baseline Status
${baselineRows}

## Topology
\`\`\`
${report.topology}
\`\`\`

## Recommended Alerts
${alertsBullets}

---
*Auto-saved by AZ Doctor triage*
`;
}
// ─── Tool Registration ──────────────────────────────────────────────
export function registerTriage(server) {
    server.tool("azdoctor_triage", "Run the full diagnostic pipeline on a resource in one command. Chains: permission check → multi-signal investigation → baseline comparison → alert recommendations → auto-saves to journal. Returns a comprehensive triage report.", {
        resource: z.string().describe("Resource name or full Azure resource ID"),
        subscription: z
            .string()
            .optional()
            .describe("Azure subscription ID (auto-detected if omitted)"),
        resourceGroup: z
            .string()
            .optional()
            .describe("Resource group name"),
        symptom: z
            .string()
            .optional()
            .describe("User-described symptom"),
        timeframeHours: z
            .number()
            .default(24)
            .describe("Investigation lookback window in hours"),
        baselineDays: z
            .number()
            .default(7)
            .describe("Baseline comparison lookback in days"),
        saveToJournal: z
            .boolean()
            .default(true)
            .describe("Auto-save the triage report to the incident journal"),
        generateAlerts: z
            .boolean()
            .default(true)
            .describe("Generate alert rule recommendations"),
    }, async ({ resource, subscription: subParam, resourceGroup, symptom, timeframeHours, baselineDays, saveToJournal, generateAlerts, }) => {
        const startTime = Date.now();
        const errors = [];
        const allEvents = [];
        // ── Phase 1: Resolve & Permissions ────────────────────────────
        const subscription = await resolveSubscription(subParam);
        // Resolve resource via Resource Graph
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
        // Quick permissions check — run health, activity, and metrics probes in parallel
        const permissionsCheck = {
            resourceHealth: false,
            activityLog: false,
            metrics: false,
            logAnalytics: false,
            summary: "",
        };
        // ── Phase 2: Investigation (parallel where possible) ──────────
        const metricConfig = getMetricConfig(resourceType);
        const [healthResult, activityResult, metricsResult, workspacesResult] = await Promise.all([
            getResourceHealth(subscription, resourceId),
            getActivityLogs(subscription, timeframeHours, resourceId),
            metricConfig
                ? getMetrics(resourceId, metricConfig.names, timeframeHours)
                : Promise.resolve({ data: null, error: undefined }),
            resolvedResourceGroup
                ? discoverWorkspaces(subscription, resolvedResourceGroup)
                : Promise.resolve({ workspaces: [], error: undefined }),
        ]);
        // Track permissions from results
        permissionsCheck.resourceHealth = !healthResult.error;
        permissionsCheck.activityLog = !activityResult.error;
        permissionsCheck.metrics = !metricsResult.error;
        permissionsCheck.logAnalytics = !workspacesResult.error;
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
        const metricDataByName = new Map();
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
                    // Store for baseline comparison
                    metricDataByName.set(metric.name, dataPoints);
                    const anomalies = detectMetricAnomalies(resourceId, metric.name, dataPoints, {
                        warningPct: metricConfig.warningPct,
                        criticalPct: metricConfig.criticalPct,
                    });
                    allEvents.push(...anomalies);
                    if (dataPoints.length >= 3) {
                        const trend = detectTrends(dataPoints, metric.name);
                        if (trend.trend !== "stable") {
                            metricTrends.push(trend);
                        }
                    }
                }
            }
        }
        // Dependency discovery + health checks
        const dependentResources = [];
        if (resolvedResourceGroup) {
            const depQueries = getDependencyQueries(resourceType, resolvedResourceGroup);
            if (depQueries.length > 0) {
                const depResults = await Promise.all(depQueries.map((dq) => queryResourceGraph([subscription], dq.query)));
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
                // Deduplicate
                const uniqueDeps = new Map();
                for (const dep of allDeps) {
                    if (!uniqueDeps.has(dep.id)) {
                        uniqueDeps.set(dep.id, dep);
                    }
                }
                // Check health in batches of 5
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
        // Correlate all events
        const correlation = correlateTimelines(allEvents);
        // ── Phase 3: Analysis (parallel) ──────────────────────────────
        // Diagnostic patterns
        const diagnosticInsights = detectDiagnosticPatterns(allEvents, resourceType);
        // Baseline comparison — pull metrics for baselineDays * 24 hours
        const baselineMetrics = [];
        if (metricConfig) {
            const baselineHours = baselineDays * 24;
            const baselineResult = await getMetrics(resourceId, metricConfig.names, baselineHours, "PT1H");
            if (baselineResult.error) {
                errors.push(baselineResult.error);
            }
            else if (baselineResult.data) {
                for (const metric of baselineResult.data.metrics) {
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
                        const bl = computeBaseline(dataPoints, metric.name);
                        if (bl)
                            baselineMetrics.push(bl);
                    }
                }
            }
        }
        // Baseline overall status
        const anomalousCount = baselineMetrics.filter((m) => m.status === "anomalous").length;
        const elevatedCount = baselineMetrics.filter((m) => m.status === "elevated").length;
        let baselineOverallStatus;
        if (anomalousCount > 0) {
            baselineOverallStatus = `${anomalousCount} metric(s) anomalous`;
        }
        else if (elevatedCount > 0) {
            baselineOverallStatus = `${elevatedCount} metric(s) elevated`;
        }
        else {
            baselineOverallStatus = "All metrics within normal range";
        }
        // Build topology
        const rootNode = {
            name: resourceName,
            type: resourceType,
            health: currentHealth === "Available"
                ? "Available"
                : currentHealth === "Degraded"
                    ? "Degraded"
                    : currentHealth === "Unavailable"
                        ? "Unavailable"
                        : "Unknown",
            isRoot: true,
        };
        const depNodes = dependentResources.map((d) => ({
            name: d.name,
            type: d.type,
            health: d.health === "Available"
                ? "Available"
                : d.health === "Degraded"
                    ? "Degraded"
                    : d.health === "Unavailable"
                        ? "Unavailable"
                        : "Unknown",
            isRoot: false,
        }));
        const topologyAscii = renderTopology(rootNode, depNodes);
        // ── Phase 4: Recommendations ──────────────────────────────────
        // Alert recommendations
        const alertRecommendations = generateAlerts
            ? (TRIAGE_ALERT_TEMPLATES[resourceType.toLowerCase()] ?? [])
            : [];
        // Remediation suggestions
        const remediationSuggestions = buildRemediationSuggestions(diagnosticInsights, currentHealth, dependentResources);
        // ── Phase 5: Save & Report ────────────────────────────────────
        const timestamp = new Date().toISOString();
        const durationMs = Date.now() - startTime;
        const triageDuration = `${(durationMs / 1000).toFixed(1)}s`;
        // Build permissions summary
        const accessibleAPIs = [];
        const inaccessibleAPIs = [];
        if (permissionsCheck.resourceHealth)
            accessibleAPIs.push("Resource Health");
        else
            inaccessibleAPIs.push("Resource Health");
        if (permissionsCheck.activityLog)
            accessibleAPIs.push("Activity Log");
        else
            inaccessibleAPIs.push("Activity Log");
        if (permissionsCheck.metrics)
            accessibleAPIs.push("Metrics");
        else
            inaccessibleAPIs.push("Metrics");
        if (permissionsCheck.logAnalytics)
            accessibleAPIs.push("Log Analytics");
        else
            inaccessibleAPIs.push("Log Analytics");
        permissionsCheck.summary =
            inaccessibleAPIs.length === 0
                ? "All APIs accessible — full diagnostic data available."
                : `${accessibleAPIs.length}/4 APIs accessible. Inaccessible: ${inaccessibleAPIs.join(", ")}.`;
        // Journal save
        let journalSaved = false;
        let journalPath;
        if (saveToJournal) {
            try {
                ensureJournalDir();
                const now = new Date();
                const filename = `triage-${sanitizeResourceName(resourceName)}-${formatDateForFilename(now)}.md`;
                journalPath = join(JOURNAL_DIR, filename);
                const markdownContent = buildJournalMarkdown({
                    resource: resourceName,
                    resourceType,
                    timestamp,
                    currentHealth,
                    confidence: correlation.confidence,
                    likelyCause: correlation.likelyCause,
                    diagnosticInsights,
                    metricTrends,
                    baseline: {
                        overallStatus: baselineOverallStatus,
                        metrics: baselineMetrics,
                        lookbackDays: baselineDays,
                    },
                    topology: topologyAscii,
                    alertRecommendations,
                });
                writeFileSync(journalPath, markdownContent, "utf-8");
                journalSaved = true;
            }
            catch {
                journalSaved = false;
            }
        }
        // Build error summary
        const errorSummary = formatErrorSummary(errors);
        // Build response
        const response = {
            // Header
            resource: resourceName,
            resourceType,
            subscription,
            timestamp,
            triageDuration,
            // Permissions
            permissions: permissionsCheck,
            // Investigation
            currentHealth,
            confidence: correlation.confidence,
            cascadingFailure: correlation.cascadingFailure,
            likelyCause: correlation.likelyCause,
            timeline: correlation.timeline,
            diagnosticInsights: diagnosticInsights.length > 0 ? diagnosticInsights : [],
            metricTrends: metricTrends.length > 0 ? metricTrends : [],
            // Dependencies
            topology: topologyAscii,
            dependentResources: dependentResources.map((d) => ({
                name: d.name,
                type: d.type,
                health: d.health,
            })),
            // Baseline
            baseline: {
                overallStatus: baselineOverallStatus,
                metrics: baselineMetrics,
                lookbackDays: baselineDays,
            },
            // Recommendations
            alertRecommendations,
            remediationSuggestions,
            // Journal
            journalSaved,
            journalPath,
            // Errors
            diagnosticCoverage: errorSummary.message,
            errors: errors.length > 0 ? errors : undefined,
        };
        return {
            content: [
                { type: "text", text: JSON.stringify(response, null, 2) },
            ],
        };
    });
}
//# sourceMappingURL=triage.js.map