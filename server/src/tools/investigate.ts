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

export function registerInvestigate(server: McpServer): void {
  server.tool(
    "azdoctor_investigate",
    "Investigate an Azure resource by gathering data from Resource Health, Activity Logs, Metrics, Log Analytics, and dependent resources. Returns comprehensive raw diagnostic data for analysis.",
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
        .describe('User-described symptom (e.g., "slow", "500 errors", "unreachable")'),
    },
    async ({ resource, subscription: subParam, resourceGroup, timeframeHours, symptom }) => {
      const subscription = await resolveSubscription(subParam);
      const errors: AzureError[] = [];

      // 1. Resolve resource
      let resourceId = resource;
      let resourceType = "Unknown";
      let resourceName = resource;
      let resolvedResourceGroup = resourceGroup;

      if (!resource.startsWith("/subscriptions/")) {
        const rgFilter = resourceGroup ? `| where resourceGroup =~ '${resourceGroup}'` : "";
        const resolveQuery = `Resources | where name =~ '${resource}' ${rgFilter} | project id, name, type, location, resourceGroup, properties | take 1`;
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

      // 2. For App Services, resolve the hosting plan (CPU/memory metrics live there)
      let appServicePlanId: string | null = null;
      if (resourceType.toLowerCase() === "microsoft.web/sites") {
        const planQuery = `Resources | where type =~ 'microsoft.web/sites' and name =~ '${resourceName}' ${resolvedResourceGroup ? `and resourceGroup =~ '${resolvedResourceGroup}'` : ""} | project serverFarmId = properties.serverFarmId | take 1`;
        const planResult = await queryResourceGraph([subscription], planQuery);
        if (planResult.resources.length > 0) {
          appServicePlanId = planResult.resources[0]["serverFarmId"] as string ?? null;
        }
      }

      // 3. Gather ALL signals in parallel
      const metricPromises: Array<{ label: string; promise: ReturnType<typeof getMetrics> }> = [];

      // Site-level metrics (HTTP errors, response time, requests)
      if (resourceType.toLowerCase() === "microsoft.web/sites") {
        metricPromises.push({
          label: `${resourceName} (site)`,
          promise: getMetrics(resourceId, ["Http5xx", "Http4xx", "Http2xx", "HttpResponseTime", "Requests", "HealthCheckStatus"], timeframeHours, "PT5M"),
        });
        // Plan-level metrics (CPU, memory)
        if (appServicePlanId) {
          metricPromises.push({
            label: `${resourceName} (plan)`,
            promise: getMetrics(appServicePlanId, ["CpuPercentage", "MemoryPercentage"], timeframeHours, "PT5M"),
          });
        }
      } else {
        // Generic: use standard metric names for the resource type
        const RESOURCE_METRICS: Record<string, string[]> = {
          "microsoft.sql/servers/databases": ["dtu_consumption_percent", "cpu_percent", "connection_failed", "deadlock", "storage_percent"],
          "microsoft.compute/virtualmachines": ["Percentage CPU", "Available Memory Bytes", "Disk Read Bytes/sec", "Disk Write Bytes/sec", "Network In Total", "Network Out Total"],
          "microsoft.cache/redis": ["percentProcessorTime", "usedmemorypercentage", "connectedclients", "totalcommandsprocessed", "cacheRead", "cacheWrite"],
          "microsoft.documentdb/databaseaccounts": ["TotalRequests", "TotalRequestUnits", "ProvisionedThroughput", "ServiceAvailability"],
        };
        const metricNames = RESOURCE_METRICS[resourceType.toLowerCase()];
        if (metricNames) {
          metricPromises.push({
            label: resourceName,
            promise: getMetrics(resourceId, metricNames, timeframeHours, "PT5M"),
          });
        }
      }

      const [healthResult, activityResult, ...metricResults] = await Promise.all([
        getResourceHealth(subscription, resourceId),
        getActivityLogs(subscription, timeframeHours, resourceId),
        ...metricPromises.map((m) => m.promise),
      ]);

      // 4. Process health
      let currentHealth = "Unknown";
      let healthDetails: Record<string, unknown> | undefined;
      if (healthResult.error) {
        errors.push(healthResult.error);
      } else if (healthResult.statuses.length > 0) {
        const status = healthResult.statuses[0];
        currentHealth = status.properties?.availabilityState ?? "Unknown";
        if (currentHealth !== "Available") {
          healthDetails = {
            state: currentHealth,
            summary: status.properties?.summary,
            reason: status.properties?.reasonType,
            detailedStatus: status.properties?.detailedStatus,
            recommendedAction: status.properties?.recommendedActions?.[0]?.action,
          };
        }
      }

      // 5. Process activity log — only notable events
      const activityEvents: Array<Record<string, unknown>> = [];
      if (activityResult.error) {
        errors.push(activityResult.error);
      } else {
        for (const event of activityResult.events) {
          const status = event.status?.value ?? "";
          // Only include writes, failures, and deployments — skip reads
          if (status === "Failed" || event.operationName?.value?.includes("write") || event.operationName?.value?.includes("deploy") || event.operationName?.value?.includes("restart") || event.operationName?.value?.includes("delete")) {
            activityEvents.push({
              time: event.eventTimestamp?.toISOString(),
              operation: event.operationName?.localizedValue ?? event.operationName?.value,
              status,
              caller: event.caller,
            });
          }
        }
      }

      // 6. Process metrics — extract actual values
      interface MetricSummary {
        name: string;
        source: string;
        current: number | null;
        max: number;
        avg: number;
        min: number;
        dataPoints: number;
        recentValues: Array<{ time: string; value: number }>;
      }
      const metricSummaries: MetricSummary[] = [];

      for (let i = 0; i < metricResults.length; i++) {
        const result = metricResults[i];
        const label = metricPromises[i]?.label ?? "unknown";
        if (result.error) {
          errors.push(result.error);
          continue;
        }
        if (!result.data) continue;

        for (const metric of result.data.metrics) {
          for (const ts of metric.timeseries) {
            if (!ts.data) continue;
            const points = ts.data
              .filter((dp) => dp.average !== undefined || dp.maximum !== undefined)
              .map((dp) => ({
                time: (dp as unknown as { timeStamp: Date }).timeStamp?.toISOString() ?? "",
                avg: dp.average ?? 0,
                max: dp.maximum ?? 0,
              }));

            if (points.length === 0) continue;

            const avgs = points.map((p) => p.avg);
            const maxes = points.map((p) => p.max);
            const current = avgs[avgs.length - 1];
            const overall_avg = avgs.reduce((a, b) => a + b, 0) / avgs.length;
            const overall_max = Math.max(...maxes);
            const overall_min = Math.min(...avgs);

            // Last 6 data points (30 min at 5min granularity) for recent trend
            const recent = points.slice(-6).map((p) => ({
              time: p.time,
              value: Math.round(p.avg * 100) / 100,
            }));

            metricSummaries.push({
              name: metric.name,
              source: label,
              current: Math.round(current * 100) / 100,
              max: Math.round(overall_max * 100) / 100,
              avg: Math.round(overall_avg * 100) / 100,
              min: Math.round(overall_min * 100) / 100,
              dataPoints: points.length,
              recentValues: recent,
            });
          }
        }
      }

      // 7. Discover dependencies and check their health
      interface DepHealth { name: string; type: string; health: string }
      const dependencies: DepHealth[] = [];
      if (resolvedResourceGroup) {
        // Find related resources — databases, caches, storage, etc.
        const depQuery = `Resources | where resourceGroup =~ '${resolvedResourceGroup}' and name != '${resourceName}' and (type =~ 'Microsoft.Sql/servers/databases' or type =~ 'Microsoft.DocumentDB/databaseAccounts' or type =~ 'Microsoft.Cache/Redis' or type =~ 'Microsoft.Storage/storageAccounts' or type =~ 'Microsoft.KeyVault/vaults' or type =~ 'Microsoft.ServiceBus/namespaces' or type =~ 'Microsoft.EventHub/namespaces') | project id, name, type`;
        const depResult = await queryResourceGraph([subscription], depQuery);
        if (depResult.error) errors.push(depResult.error);

        const uniqueDeps = new Map<string, { id: string; name: string; type: string }>();
        for (const dep of depResult.resources) {
          const id = dep.id as string;
          if (!uniqueDeps.has(id)) {
            uniqueDeps.set(id, { id, name: dep.name as string, type: dep.type as string });
          }
        }

        if (uniqueDeps.size > 0) {
          const healthChecks = await batchExecute(
            Array.from(uniqueDeps.values()).map((dep) => async () => {
              const h = await getResourceHealth(subscription, dep.id);
              return { name: dep.name, type: dep.type, health: h.statuses[0]?.properties?.availabilityState ?? "Unknown" };
            }),
            5
          );
          dependencies.push(...healthChecks);
        }
      }

      // 8. Log Analytics — get real error details
      interface LogData {
        workspace: string;
        failedRequests: Array<{ operation: string; statusCode: string; count: number; avgDurationMs: number }>;
        exceptions: Array<{ type: string; message: string; count: number }>;
        dependencyFailures: Array<{ target: string; type: string; resultCode: string; count: number; avgDurationMs: number }>;
      }
      let logData: LogData | null = null;

      if (resolvedResourceGroup) {
        const wsResult = await discoverWorkspaces(subscription, resolvedResourceGroup);
        if (wsResult.workspaces.length > 0) {
          const ws = wsResult.workspaces[0]; // Use primary workspace

          const [reqResult, excResult, depResult] = await Promise.all([
            // Failed requests with status codes and duration
            queryLogAnalytics(ws.workspaceId, `AppRequests
| where TimeGenerated > ago(${timeframeHours}h)
| where Success == false
| summarize Count = count(), AvgDuration = round(avg(DurationMs), 1) by OperationName, ResultCode
| order by Count desc
| take 10`, timeframeHours),
            // Exception details
            queryLogAnalytics(ws.workspaceId, `AppExceptions
| where TimeGenerated > ago(${timeframeHours}h)
| summarize Count = count() by ExceptionType, OuterMessage
| order by Count desc
| take 10`, timeframeHours),
            // Dependency failures (SQL calls, HTTP calls, etc.)
            queryLogAnalytics(ws.workspaceId, `AppDependencies
| where TimeGenerated > ago(${timeframeHours}h)
| where Success == false
| summarize Count = count(), AvgDuration = round(avg(DurationMs), 1) by Target, DependencyType = Type, ResultCode
| order by Count desc
| take 10`, timeframeHours),
          ]);

          if (reqResult.error) errors.push(reqResult.error);
          if (excResult.error) errors.push(excResult.error);
          if (depResult.error) errors.push(depResult.error);

          const failedRequests = (reqResult.tables?.[0]?.rows ?? []).map((r) => ({
            operation: String(r[0] ?? ""),
            statusCode: String(r[1] ?? ""),
            count: Number(r[2]) || 0,
            avgDurationMs: Number(r[3]) || 0,
          }));

          const exceptions = (excResult.tables?.[0]?.rows ?? []).map((r) => ({
            type: String(r[0] ?? ""),
            message: String(r[1] ?? ""),
            count: Number(r[2]) || 0,
          }));

          const dependencyFailures = (depResult.tables?.[0]?.rows ?? []).map((r) => ({
            target: String(r[0] ?? ""),
            type: String(r[1] ?? ""),
            resultCode: String(r[2] ?? ""),
            count: Number(r[3]) || 0,
            avgDurationMs: Number(r[4]) || 0,
          }));

          logData = {
            workspace: ws.workspaceName,
            failedRequests,
            exceptions,
            dependencyFailures,
          };
        }
      }

      // 9. Build response — raw data, no opinions
      const response: Record<string, unknown> = {
        resource: resourceName,
        resourceType,
        resourceGroup: resolvedResourceGroup,
        currentHealth,
      };

      if (healthDetails) response.healthDetails = healthDetails;
      if (symptom) response.reportedSymptom = symptom;

      if (metricSummaries.length > 0) {
        response.metrics = metricSummaries;
      } else {
        response.metrics = "No metric data available — check if the resource emits metrics or if the timeframe is too narrow.";
      }

      if (activityEvents.length > 0) {
        response.recentChanges = activityEvents;
      } else {
        response.recentChanges = "No write operations or failures in the activity log for the investigation window.";
      }

      if (logData) {
        response.logAnalytics = logData;
      }

      if (dependencies.length > 0) {
        response.dependencies = dependencies;
      }

      if (errors.length > 0) {
        response.apiErrors = errors.map((e) => `${e.code}: ${e.message}`);
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    }
  );
}
