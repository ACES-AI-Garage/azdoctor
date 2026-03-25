import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
  getResourceHealth,
  getActivityLogs,
  getMetrics,
  batchExecute,
  discoverWorkspaces,
  queryLogAnalytics,
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";
import {
  correlateTimelines,
  detectMetricAnomalies,
  detectDiagnosticPatterns,
  detectTrends,
} from "../utils/correlator.js";
import type { DiagnosticEvent, DiagnosticInsight, TrendResult } from "../utils/correlator.js";
import { getMetricConfig, getDependencyQueries } from "../utils/metric-config.js";
import { formatErrorSummary } from "../utils/formatters.js";

interface DependentResource {
  name: string;
  type: string;
  health: string;
  concern?: string;
}

interface MetricSnapshot {
  name: string;
  current: number | null;
  max: number | null;
  avg: number | null;
  trend: string;
  status: "normal" | "warning" | "critical";
}

export function registerInvestigate(server: McpServer): void {
  server.tool(
    "azdoctor_investigate",
    "Investigate a specific Azure resource or incident. Performs multi-signal correlation across Resource Health, Activity Logs, Metrics, and dependent resources to identify root cause.",
    {
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
        .describe(
          'User-described symptom (e.g., "slow", "500 errors", "unreachable")'
        ),
    },
    async ({
      resource,
      subscription: subParam,
      resourceGroup,
      timeframeHours,
      symptom,
    }) => {
      const subscription = await resolveSubscription(subParam);
      const errors: AzureError[] = [];
      const allEvents: DiagnosticEvent[] = [];

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
          resourceId = (r.id as string) ?? resource;
          resourceType = (r.type as string) ?? "Unknown";
          resourceName = (r.name as string) ?? resource;
          resolvedResourceGroup = (r.resourceGroup as string) ?? resourceGroup;
        } else if (resolved.error) {
          errors.push(resolved.error);
        }
      } else {
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

      const [healthResult, activityResult, metricsResult] =
        await Promise.all([
          getResourceHealth(subscription, resourceId),
          getActivityLogs(subscription, timeframeHours, resourceId),
          metricConfig
            ? getMetrics(resourceId, metricConfig.names, timeframeHours)
            : Promise.resolve({ data: null, error: undefined }),
        ]);

      // Process health result
      let currentHealth = "Unknown";
      if (healthResult.error) {
        errors.push(healthResult.error);
      } else if (healthResult.statuses.length > 0) {
        const status = healthResult.statuses[0];
        currentHealth =
          status.properties?.availabilityState ?? "Unknown";

        if (currentHealth !== "Available") {
          allEvents.push({
            time: new Date().toISOString(),
            event: `Health status: ${currentHealth} — ${status.properties?.summary ?? ""}`,
            source: "ResourceHealth",
            resource: resourceName,
            severity:
              currentHealth === "Unavailable" ? "critical" : "warning",
          });
        }
      }

      // Process activity log
      if (activityResult.error) {
        errors.push(activityResult.error);
      } else {
        for (const event of activityResult.events) {
          const opName =
            event.operationName?.localizedValue ??
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
            severity:
              status === "Failed" ? "warning" : "info",
          });
        }
      }

      // Process metrics — build snapshots with current values AND detect trends
      const metricSnapshots: MetricSnapshot[] = [];
      const metricTrends: TrendResult[] = [];

      if (metricsResult.error) {
        errors.push(metricsResult.error);
      } else if (metricsResult.data && metricConfig) {
        for (const metric of metricsResult.data.metrics) {
          for (const ts of metric.timeseries) {
            if (!ts.data) continue;
            const dataPoints = ts.data
              .filter((dp) => dp.average !== undefined || dp.maximum !== undefined)
              .map((dp) => ({
                timestamp:
                  (dp as unknown as { timeStamp: Date }).timeStamp?.toISOString() ??
                  new Date().toISOString(),
                average: dp.average ?? undefined,
                maximum: dp.maximum ?? undefined,
              }));

            if (dataPoints.length === 0) continue;

            // Compute summary stats
            const averages = dataPoints.map((d) => d.average).filter((v): v is number => v !== undefined);
            const maxima = dataPoints.map((d) => d.maximum).filter((v): v is number => v !== undefined);

            const currentVal = averages.length > 0 ? averages[averages.length - 1] : null;
            const maxVal = maxima.length > 0 ? Math.max(...maxima) : (averages.length > 0 ? Math.max(...averages) : null);
            const avgVal = averages.length > 0 ? averages.reduce((a, b) => a + b, 0) / averages.length : null;

            // Determine status based on thresholds
            let status: "normal" | "warning" | "critical" = "normal";
            if (currentVal !== null) {
              if (currentVal >= metricConfig.criticalPct) status = "critical";
              else if (currentVal >= metricConfig.warningPct) status = "warning";
            }

            // Detect anomalies
            const anomalies = detectMetricAnomalies(
              resourceId, metric.name, dataPoints,
              { warningPct: metricConfig.warningPct, criticalPct: metricConfig.criticalPct }
            );
            allEvents.push(...anomalies);

            // Detect trend
            let trendDirection = "stable";
            if (dataPoints.length >= 3) {
              const trend = detectTrends(dataPoints, metric.name);
              trendDirection = trend.trend;
              if (trend.trend !== "stable") {
                metricTrends.push(trend);
              }
            }

            metricSnapshots.push({
              name: metric.name,
              current: currentVal !== null ? Math.round(currentVal * 100) / 100 : null,
              max: maxVal !== null ? Math.round(maxVal * 100) / 100 : null,
              avg: avgVal !== null ? Math.round(avgVal * 100) / 100 : null,
              trend: trendDirection,
              status,
            });
          }
        }
      }

      // 6. Identify dependent resources
      const dependentResources: DependentResource[] = [];
      if (resolvedResourceGroup) {
        const depQueries = getDependencyQueries(resourceType, resolvedResourceGroup);
        if (depQueries.length > 0) {
          const depResults = await Promise.all(
            depQueries.map((dq) => queryResourceGraph([subscription], dq.query))
          );

          const uniqueDeps = new Map<string, { id: string; name: string; type: string }>();
          for (const result of depResults) {
            for (const dep of result.resources) {
              const id = dep.id as string;
              if (!uniqueDeps.has(id)) {
                uniqueDeps.set(id, { id, name: dep.name as string, type: dep.type as string });
              }
            }
            if (result.error) errors.push(result.error);
          }

          const healthChecks = await batchExecute(
            Array.from(uniqueDeps.values()).map((dep) => async () => {
              const depHealth = await getResourceHealth(subscription, dep.id);
              const depState =
                depHealth.statuses[0]?.properties?.availabilityState ?? "Unknown";
              return { dep, depState };
            }),
            5
          );

          for (const { dep, depState } of healthChecks) {
            dependentResources.push({
              name: dep.name,
              type: dep.type,
              health: depState,
              concern: depState !== "Available" ? `${dep.name} is ${depState}` : undefined,
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

      // 7. Log Analytics — get actual error details, not just counts
      interface LogInsight {
        workspace: string;
        errorCount: number;
        topErrors: Array<{ operation: string; message: string; count: number }>;
        recentExceptions: string[];
      }
      let logAnalyticsInsights: LogInsight[] = [];

      if (resolvedResourceGroup) {
        const wsResult = await discoverWorkspaces(subscription, resolvedResourceGroup);
        if (wsResult.workspaces.length > 0) {
          const wsInsights = await batchExecute(
            wsResult.workspaces.map((ws) => async () => {
              // Query 1: Top failing operations with error details
              const errQuery = `AppRequests
| where TimeGenerated > ago(${timeframeHours}h)
| where Success == false
| summarize Count = count(), AvgDuration = avg(DurationMs) by OperationName, ResultCode
| order by Count desc
| take 10`;
              const errResult = await queryLogAnalytics(ws.workspaceId, errQuery, timeframeHours);

              // Query 2: Recent exception messages
              const excQuery = `AppExceptions
| where TimeGenerated > ago(${timeframeHours}h)
| summarize Count = count() by ExceptionType, OuterMessage
| order by Count desc
| take 5`;
              const excResult = await queryLogAnalytics(ws.workspaceId, excQuery, timeframeHours);

              if (errResult.error) errors.push(errResult.error);
              if (excResult.error) errors.push(excResult.error);

              const errRows = errResult.tables?.[0]?.rows ?? [];
              const excRows = excResult.tables?.[0]?.rows ?? [];

              const topErrors = errRows.map((row) => ({
                operation: String(row[0] ?? "Unknown"),
                message: `HTTP ${String(row[1] ?? "?")} — avg ${Math.round(Number(row[3]) || 0)}ms`,
                count: Number(row[2]) || 0,
              }));

              const errorCount = topErrors.reduce((sum, e) => sum + e.count, 0);

              const recentExceptions = excRows.map((row) =>
                `${String(row[0] ?? "Unknown")}: ${String(row[1] ?? "No message")} (${row[2]}x)`
              );

              return {
                workspace: ws.workspaceName,
                errorCount,
                topErrors,
                recentExceptions,
              } as LogInsight;
            }),
            3
          );
          logAnalyticsInsights = wsInsights.filter((r): r is NonNullable<typeof r> => r !== null);
        }
      }

      // 8. Correlate timestamps across all signals
      const correlation = correlateTimelines(allEvents);

      // 9. Detect service-specific diagnostic patterns
      const diagnosticInsights: DiagnosticInsight[] = detectDiagnosticPatterns(allEvents, resourceType);

      // 10. Build a smart likely cause that uses ALL signals
      const likelyCause = buildLikelyCause(
        currentHealth, correlation, metricSnapshots, logAnalyticsInsights, dependentResources, symptom
      );

      // 11. Build investigation output — lead with what matters
      const errorSummary = formatErrorSummary(errors);

      // Only include fields that have meaningful data
      const response: Record<string, unknown> = {
        resource: resourceName,
        resourceType,
        currentHealth,
      };

      // Metrics — always include if we have data
      if (metricSnapshots.length > 0) {
        response.metrics = metricSnapshots;
      }

      // Errors from logs — the most actionable data
      if (logAnalyticsInsights.length > 0 && logAnalyticsInsights.some((l) => l.errorCount > 0)) {
        response.errors_detected = logAnalyticsInsights.map((l) => ({
          workspace: l.workspace,
          totalErrors: l.errorCount,
          failingEndpoints: l.topErrors,
          exceptions: l.recentExceptions.length > 0 ? l.recentExceptions : undefined,
        }));
      }

      // Likely cause — the diagnosis
      response.likelyCause = likelyCause;

      // Dependencies — only non-healthy ones prominently, rest as summary
      const unhealthyDeps = dependentResources.filter((d) => d.health !== "Available");
      const healthyDeps = dependentResources.filter((d) => d.health === "Available");
      if (unhealthyDeps.length > 0) {
        response.unhealthyDependencies = unhealthyDeps;
      }
      if (healthyDeps.length > 0) {
        response.healthyDependencies = healthyDeps.map((d) => `${d.name} (${d.type})`);
      }

      // Diagnostic patterns — only if detected
      if (diagnosticInsights.length > 0) {
        response.diagnosticPatterns = diagnosticInsights;
      }

      // Activity — only failed or notable changes
      const notableEvents = correlation.timeline.filter(
        (e) => e.severity === "critical" || e.severity === "warning"
      );
      if (notableEvents.length > 0) {
        response.recentChanges = notableEvents.slice(0, 10);
      }

      // Recommendations
      response.recommendedActions = buildRecommendations(
        currentHealth, correlation, dependentResources, metricSnapshots, logAnalyticsInsights, symptom
      );

      // Confidence
      response.confidence = correlation.confidence;

      // API errors (if any)
      if (errors.length > 0) {
        response.apiErrors = errorSummary.message;
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    }
  );
}

function buildLikelyCause(
  currentHealth: string,
  correlation: ReturnType<typeof correlateTimelines>,
  metrics: MetricSnapshot[],
  logs: Array<{ errorCount: number; topErrors: Array<{ operation: string; message: string; count: number }> }>,
  deps: DependentResource[],
  symptom?: string
): string {
  const parts: string[] = [];

  // Check for application errors first — most actionable
  const totalErrors = logs.reduce((sum, l) => sum + l.errorCount, 0);
  if (totalErrors > 0) {
    const topError = logs.flatMap((l) => l.topErrors).sort((a, b) => b.count - a.count)[0];
    if (topError) {
      parts.push(
        `${totalErrors} application errors detected. Top failing endpoint: ${topError.operation} (${topError.count}x, ${topError.message}).`
      );
    }
  }

  // Check for metric anomalies
  const criticalMetrics = metrics.filter((m) => m.status === "critical");
  const warningMetrics = metrics.filter((m) => m.status === "warning");
  if (criticalMetrics.length > 0) {
    const names = criticalMetrics.map((m) => `${m.name}: ${m.current}%`).join(", ");
    parts.push(`Critical metric thresholds breached: ${names}.`);
  } else if (warningMetrics.length > 0) {
    const names = warningMetrics.map((m) => `${m.name}: ${m.current}%`).join(", ");
    parts.push(`Elevated metrics: ${names}.`);
  }

  // Check for preceding changes
  if (correlation.precedingChanges.length > 0) {
    const change = correlation.precedingChanges[correlation.precedingChanges.length - 1];
    parts.push(
      `A configuration change was detected before the anomaly: "${change.event}" at ${change.time}${change.actor ? ` by ${change.actor}` : ""}.`
    );
  }

  // Check for unhealthy dependencies
  const unhealthyDeps = deps.filter((d) => d.health !== "Available");
  if (unhealthyDeps.length > 0) {
    parts.push(
      `Dependency issue: ${unhealthyDeps.map((d) => `${d.name} is ${d.health}`).join(", ")}.`
    );
  }

  // Check health status
  if (currentHealth === "Unavailable") {
    parts.unshift(`Resource is currently Unavailable.`);
  } else if (currentHealth === "Degraded") {
    parts.unshift(`Resource is currently Degraded.`);
  }

  if (parts.length === 0) {
    if (currentHealth === "Available" && totalErrors === 0) {
      return "No issues detected. The resource appears healthy with no recent errors or metric anomalies.";
    }
    return "Unable to determine root cause from available signals. Consider checking application-level logs or expanding the investigation window.";
  }

  return parts.join(" ");
}

function buildRecommendations(
  currentHealth: string,
  correlation: ReturnType<typeof correlateTimelines>,
  deps: DependentResource[],
  metrics: MetricSnapshot[],
  logs: Array<{ errorCount: number; topErrors: Array<{ operation: string; count: number }> }>,
  symptom?: string
): string[] {
  const actions: string[] = [];

  // Errors → investigate the failing endpoints
  const totalErrors = logs.reduce((sum, l) => sum + l.errorCount, 0);
  if (totalErrors > 0) {
    const topEndpoints = logs.flatMap((l) => l.topErrors).sort((a, b) => b.count - a.count).slice(0, 3);
    for (const ep of topEndpoints) {
      actions.push(`Investigate ${ep.operation} — ${ep.count} failures detected.`);
    }
  }

  // Preceding changes → suggest rollback
  if (correlation.precedingChanges.length > 0) {
    actions.push("Review and potentially roll back the recent configuration change.");
  }

  // Critical metrics → resource-specific advice
  const criticalMetrics = metrics.filter((m) => m.status === "critical");
  for (const m of criticalMetrics) {
    if (m.name.toLowerCase().includes("cpu")) {
      actions.push(`CPU is at ${m.current}% — consider scaling up or optimizing workload.`);
    } else if (m.name.toLowerCase().includes("memory")) {
      actions.push(`Memory is at ${m.current}% — check for memory leaks or increase memory allocation.`);
    } else if (m.name.toLowerCase().includes("dtu") || m.name.toLowerCase().includes("cpu") && m.name.toLowerCase().includes("sql")) {
      actions.push(`Database DTU/CPU at ${m.current}% — consider scaling the database tier.`);
    } else {
      actions.push(`${m.name} is at ${m.current}% — investigate and consider scaling.`);
    }
  }

  // Unhealthy dependencies
  const unhealthyDeps = deps.filter((d) => d.health !== "Available");
  for (const dep of unhealthyDeps) {
    actions.push(`Investigate dependency ${dep.name} — currently ${dep.health}.`);
  }

  // Resource health
  if (currentHealth === "Unavailable" || currentHealth === "Degraded") {
    actions.push("Check Azure Service Health for platform incidents in this region.");
  }

  if (actions.length === 0) {
    actions.push("No immediate action required — resource appears healthy.");
  }

  return actions;
}
