import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
  getResourceHealth,
  getActivityLogs,
  getMetrics,
  querySqlQueryStore,
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";
import type { QueryStoreInsight } from "../utils/azure-client.js";
import {
  correlateTimelines,
  detectMetricAnomalies,
} from "../utils/correlator.js";
import type { DiagnosticEvent } from "../utils/correlator.js";

/** Common metric names by resource type for automatic querying */
const METRIC_MAP: Record<string, { names: string[]; warningPct: number; criticalPct: number }> = {
  "microsoft.web/sites": {
    names: ["Http5xx", "HttpResponseTime", "CpuPercentage", "MemoryPercentage"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.sql/servers/databases": {
    names: ["dtu_consumption_percent", "connection_failed", "deadlock"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.compute/virtualmachines": {
    names: ["Percentage CPU", "Available Memory Bytes"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.documentdb/databaseaccounts": {
    names: ["TotalRequestUnits", "NormalizedRUConsumption"],
    warningPct: 80,
    criticalPct: 95,
  },
  "microsoft.cache/redis": {
    names: ["percentProcessorTime", "usedmemorypercentage", "serverLoad"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.storage/storageaccounts": {
    names: ["Availability", "SuccessE2ELatency"],
    warningPct: 80,
    criticalPct: 90,
  },
};

interface DependentResource {
  name: string;
  type: string;
  health: string;
  concern?: string;
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
        } else if (resolved.error) {
          errors.push(resolved.error);
        }
      } else {
        // Parse resource ID for type and name
        const parts = resource.split("/");
        resourceName = parts[parts.length - 1] ?? resource;
        // Extract type from resource ID (e.g., Microsoft.Web/sites)
        const providerIdx = parts.indexOf("providers");
        if (providerIdx !== -1 && parts.length > providerIdx + 2) {
          resourceType = `${parts[providerIdx + 1]}/${parts[providerIdx + 2]}`;
        }
      }

      // 2-5: Gather signals in parallel
      const [healthResult, activityResult, metricsResult] =
        await Promise.all([
          // 2. Check Resource Health
          getResourceHealth(subscription, resourceId),
          // 3. Pull Activity Log for this resource
          getActivityLogs(subscription, timeframeHours, resourceId),
          // 4. Pull metrics (if we know the resource type)
          (async () => {
            const typeKey = resourceType.toLowerCase();
            const metricConfig = METRIC_MAP[typeKey];
            if (metricConfig) {
              return getMetrics(
                resourceId,
                metricConfig.names,
                timeframeHours
              );
            }
            return { data: null, error: undefined };
          })(),
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

      // Process metrics
      if (metricsResult.error) {
        errors.push(metricsResult.error);
      } else if (metricsResult.data) {
        const typeKey = resourceType.toLowerCase();
        const metricConfig = METRIC_MAP[typeKey];
        if (metricConfig) {
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
              const anomalies = detectMetricAnomalies(
                resourceId,
                metric.name,
                dataPoints,
                {
                  warningPct: metricConfig.warningPct,
                  criticalPct: metricConfig.criticalPct,
                }
              );
              allEvents.push(...anomalies);
            }
          }
        }
      }

      // 6. Identify dependent resources via Resource Graph
      const dependentResources: DependentResource[] = [];
      if (resourceType.toLowerCase() === "microsoft.web/sites") {
        // App Service → look for connected databases, caches
        const depQuery = `Resources | where resourceGroup =~ '${resourceGroup ?? ""}' and (type =~ 'Microsoft.Sql/servers/databases' or type =~ 'Microsoft.Cache/Redis' or type =~ 'Microsoft.DocumentDB/databaseAccounts') | project id, name, type`;
        const deps = await queryResourceGraph([subscription], depQuery);
        for (const dep of deps.resources) {
          const depId = dep.id as string;
          const depHealth = await getResourceHealth(subscription, depId);
          const depState =
            depHealth.statuses[0]?.properties?.availabilityState ?? "Unknown";
          dependentResources.push({
            name: dep.name as string,
            type: dep.type as string,
            health: depState,
            concern:
              depState !== "Available"
                ? `${dep.name} is ${depState}`
                : undefined,
          });
          if (depState !== "Available") {
            allEvents.push({
              time: new Date().toISOString(),
              event: `Dependent resource ${dep.name} health: ${depState}`,
              source: "ResourceHealth",
              resource: dep.name as string,
              severity: "warning",
            });
          }
        }
      }

      // 6b. SQL DB Query Store — auto-query when performance anomalies detected
      let queryStoreInsights: QueryStoreInsight[] | undefined;
      if (resourceType.toLowerCase() === "microsoft.sql/servers/databases") {
        const hasPerformanceAnomaly = allEvents.some(
          (e) =>
            e.source === "Metrics" &&
            (e.severity === "warning" || e.severity === "critical")
        );
        // Query Store is valuable even without anomalies for perf investigation
        if (hasPerformanceAnomaly || (symptom && /slow|perf|cpu|dtu|query|latenc/i.test(symptom))) {
          // Extract server name and database name from the resource ID
          // Format: /subscriptions/.../providers/Microsoft.Sql/servers/{server}/databases/{db}
          const idParts = resourceId.split("/");
          const serversIdx = idParts.findIndex(
            (p) => p.toLowerCase() === "servers"
          );
          const dbIdx = idParts.findIndex(
            (p) => p.toLowerCase() === "databases"
          );
          if (serversIdx !== -1 && dbIdx !== -1) {
            const serverName = idParts[serversIdx + 1];
            const dbName = idParts[dbIdx + 1];

            // Resolve server FQDN from Resource Graph (handles sovereign clouds)
            const serverRgQuery = `Resources | where type =~ 'Microsoft.Sql/servers' and name =~ '${serverName}' | project properties.fullyQualifiedDomainName | take 1`;
            let serverFqdn = `${serverName}.database.windows.net`;
            try {
              const serverResult = await queryResourceGraph([subscription], serverRgQuery);
              const fqdn = serverResult.resources[0]?.["properties_fullyQualifiedDomainName"] as string;
              if (fqdn) serverFqdn = fqdn;
            } catch {
              // Fall back to default FQDN convention
            }

            const qsResult = await querySqlQueryStore(
              serverFqdn,
              dbName,
              timeframeHours
            );
            if (qsResult.error) {
              errors.push(qsResult.error);
            }
            if (qsResult.topQueries.length > 0) {
              queryStoreInsights = qsResult.topQueries;
              // Add top offending query as a diagnostic event
              const topQuery = qsResult.topQueries[0];
              allEvents.push({
                time: topQuery.lastExecutionTime || new Date().toISOString(),
                event: `Top resource-consuming query (ID ${topQuery.queryId}): max CPU ${topQuery.maxCpuSec}s, max duration ${topQuery.maxDurationSec}s, executions: ${topQuery.executionCount}`,
                source: "Metrics",
                resource: resourceName,
                severity: topQuery.maxCpuSec > 5 ? "critical" : "warning",
              });
            }
          }
        }
      }

      // 7. Correlate timestamps across all signals
      const correlation = correlateTimelines(allEvents);

      // 8. Build investigation output
      const now = new Date();
      const windowStart = new Date(
        now.getTime() - timeframeHours * 60 * 60 * 1000
      );

      const response = {
        resource: resourceName,
        resourceType,
        currentHealth,
        investigationWindow: `${windowStart.toISOString()} to ${now.toISOString()}`,
        symptom: symptom ?? null,
        timeline: correlation.timeline,
        likelyCause: correlation.likelyCause,
        earliestAnomaly: correlation.earliestAnomaly,
        precedingChanges: correlation.precedingChanges,
        dependentResources,
        queryStoreInsights: queryStoreInsights ?? undefined,
        recommendedActions: buildRecommendations(
          currentHealth,
          correlation,
          dependentResources,
          symptom
        ),
        permissionGaps: errors
          .filter((e) => e.code === "FORBIDDEN")
          .map((e) => ({
            api: e.message,
            recommendation: e.roleRecommendation,
          })),
        errors: errors.length > 0 ? errors : undefined,
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    }
  );
}

function buildRecommendations(
  currentHealth: string,
  correlation: ReturnType<typeof correlateTimelines>,
  dependentResources: DependentResource[],
  symptom?: string
): string[] {
  const actions: string[] = [];

  if (correlation.precedingChanges.length > 0) {
    const lastChange =
      correlation.precedingChanges[correlation.precedingChanges.length - 1];
    actions.push(
      `Review the change at ${lastChange.time}: "${lastChange.event}"${lastChange.actor ? ` (by ${lastChange.actor})` : ""}`
    );
    actions.push("Consider rolling back the change if immediate mitigation is needed.");
  }

  if (currentHealth === "Unavailable" || currentHealth === "Degraded") {
    actions.push(
      "Check Azure Service Health for ongoing platform incidents in the resource's region."
    );
  }

  const unhealthyDeps = dependentResources.filter(
    (d) => d.health !== "Available"
  );
  if (unhealthyDeps.length > 0) {
    for (const dep of unhealthyDeps) {
      actions.push(
        `Investigate dependent resource ${dep.name} (${dep.type}) — currently ${dep.health}.`
      );
    }
  }

  if (actions.length === 0) {
    actions.push(
      "No clear root cause identified from available signals.",
      "Search Microsoft Learn docs for troubleshooting guidance specific to this resource type and symptom.",
      "Check if there are Log Analytics workspaces with additional diagnostic data."
    );
  }

  return actions;
}
