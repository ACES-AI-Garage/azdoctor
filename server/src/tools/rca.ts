import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
  getResourceHealth,
  getActivityLogs,
  getMetrics,
  listMetricDefinitions,
  batchExecute,
  discoverWorkspaces,
  queryLogAnalytics,
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";

// Resources where key metrics live on a parent resource, not the resource itself.
const PARENT_METRIC_RESOURCES: Record<string, { property: string; label: string }> = {
  "microsoft.web/sites": { property: "properties.serverFarmId", label: "App Service Plan" },
};

// Dependency resource types worth checking in the same resource group
const DEPENDENCY_TYPES = [
  "microsoft.sql/servers/databases",
  "microsoft.sql/servers",
  "microsoft.dbformysql/flexibleservers",
  "microsoft.dbforpostgresql/flexibleservers",
  "microsoft.cache/redis",
  "microsoft.documentdb/databaseaccounts",
  "microsoft.storage/storageaccounts",
  "microsoft.keyvault/vaults",
];

// Max metrics to pull per resource to avoid huge responses
const MAX_METRICS = 15;

export function registerRca(server: McpServer): void {
  server.tool(
    "azdoctor_rca",
    "Gather comprehensive diagnostic data for a Root Cause Analysis of an Azure incident. Pulls resource health, activity logs, metrics, Log Analytics data, and dependency health for a specific time window. Returns structured raw data — the model writes the RCA from the data.",
    {
      resource: z.string().describe("Resource name or full Azure resource ID"),
      subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z.string().optional().describe("Resource group name (helps resolve resource ID faster)"),
      startTime: z.string().optional().describe("ISO timestamp for incident start (e.g. 2025-03-20T14:00:00Z)"),
      endTime: z.string().optional().describe("ISO timestamp for incident end (e.g. 2025-03-20T16:00:00Z)"),
      timeframeHours: z.number().default(24).describe("Fallback timeframe in hours if no startTime/endTime provided"),
      outputFormat: z.enum(["json", "markdown"]).default("json").describe("Output format — both return raw data; the model formats markdown"),
    },
    async ({
      resource,
      subscription: subParam,
      resourceGroup,
      startTime,
      endTime,
      timeframeHours,
      outputFormat: _outputFormat,
    }) => {
      const subscription = await resolveSubscription(subParam);
      const errors: AzureError[] = [];

      // ── Determine time window ──────────────────────────────────────────
      const now = new Date();
      const windowEnd = endTime ? new Date(endTime) : now;
      const windowStart = startTime
        ? new Date(startTime)
        : new Date(windowEnd.getTime() - timeframeHours * 60 * 60 * 1000);
      const hoursBack = Math.max(1, (windowEnd.getTime() - windowStart.getTime()) / (60 * 60 * 1000));

      // ── 1. Resolve resource ────────────────────────────────────────────
      let resourceId = resource;
      let resourceType = "unknown";
      let resourceName = resource;
      let resolvedRG = resourceGroup;
      let resourceProperties: Record<string, unknown> = {};

      if (!resource.startsWith("/subscriptions/")) {
        const rgFilter = resolvedRG ? `| where resourceGroup =~ '${resolvedRG}'` : "";
        const q = `Resources | where name =~ '${resource}' ${rgFilter} | project id, name, type, location, resourceGroup, properties | take 1`;
        const result = await queryResourceGraph([subscription], q);
        if (result.resources.length > 0) {
          const r = result.resources[0];
          resourceId = r.id as string;
          resourceType = (r.type as string) ?? "unknown";
          resourceName = (r.name as string) ?? resource;
          resolvedRG = (r.resourceGroup as string) ?? resourceGroup;
          resourceProperties = (r.properties as Record<string, unknown>) ?? {};
        } else if (result.error) {
          errors.push(result.error);
        }
      } else {
        const parts = resource.split("/");
        resourceName = parts[parts.length - 1] ?? resource;
        const pi = parts.indexOf("providers");
        if (pi !== -1 && parts.length > pi + 2) resourceType = `${parts[pi + 1]}/${parts[pi + 2]}`;
        const ri = parts.indexOf("resourceGroups");
        if (ri !== -1 && parts.length > ri + 1) resolvedRG = parts[ri + 1];
      }

      // ── 2. Discover available metrics dynamically ──────────────────────
      const metricDefs = await listMetricDefinitions(resourceId);
      if (metricDefs.error) errors.push(metricDefs.error);

      const priorityPatterns = [/percent/i, /cpu/i, /memory/i, /error/i, /5xx/i, /4xx/i, /fail/i, /latency/i, /response.*time/i, /request/i, /connection/i, /dtu/i, /throughput/i, /availability/i, /queue/i, /count/i];
      const sortedDefs = [...metricDefs.definitions].sort((a, b) => {
        const aScore = priorityPatterns.findIndex((p) => p.test(a.name));
        const bScore = priorityPatterns.findIndex((p) => p.test(b.name));
        return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
      });
      const selectedMetrics = sortedDefs.slice(0, MAX_METRICS).map((d) => d.name);

      // ── 3. Resolve parent resource for App Services ────────────────────
      const parentConfig = PARENT_METRIC_RESOURCES[resourceType.toLowerCase()];
      let parentResourceId: string | null = null;
      let parentLabel: string | null = null;

      if (parentConfig) {
        const propPath = parentConfig.property.replace("properties.", "");
        const parentId = resourceProperties[propPath] as string | undefined;
        if (parentId) {
          parentResourceId = parentId;
          parentLabel = parentConfig.label;
        } else {
          const parentQuery = `Resources | where type =~ '${resourceType}' and name =~ '${resourceName}' | project parentId = ${parentConfig.property} | take 1`;
          const parentResult = await queryResourceGraph([subscription], parentQuery);
          if (parentResult.resources.length > 0) {
            parentResourceId = parentResult.resources[0]["parentId"] as string ?? null;
            parentLabel = parentConfig.label;
          }
        }
      }

      // Discover parent metrics
      let parentMetricNames: string[] = [];
      if (parentResourceId) {
        const parentDefs = await listMetricDefinitions(parentResourceId);
        if (parentDefs.error) errors.push(parentDefs.error);
        const parentSorted = [...parentDefs.definitions].sort((a, b) => {
          const aScore = priorityPatterns.findIndex((p) => p.test(a.name));
          const bScore = priorityPatterns.findIndex((p) => p.test(b.name));
          return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
        });
        parentMetricNames = parentSorted.slice(0, MAX_METRICS).map((d) => d.name);
      }

      // ── 4. Gather ALL signals in parallel ──────────────────────────────
      const metricPromises: Array<{ label: string; resourceId: string; promise: ReturnType<typeof getMetrics> }> = [];

      if (selectedMetrics.length > 0) {
        metricPromises.push({
          label: resourceName,
          resourceId,
          promise: getMetrics(resourceId, selectedMetrics, hoursBack, "PT5M"),
        });
      }

      if (parentResourceId && parentMetricNames.length > 0) {
        metricPromises.push({
          label: `${parentLabel ?? "parent"}`,
          resourceId: parentResourceId,
          promise: getMetrics(parentResourceId, parentMetricNames, hoursBack, "PT5M"),
        });
      }

      const [healthResult, activityResult, ...metricResults] = await Promise.all([
        getResourceHealth(subscription, resourceId),
        getActivityLogs(subscription, hoursBack, resourceId),
        ...metricPromises.map((m) => m.promise),
      ]);

      // ── 5. Process health ──────────────────────────────────────────────
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
            recommendedAction: status.properties?.recommendedActions?.[0]?.action,
          };
        }
      }

      // ── 6. Process activity log — only notable events ──────────────────
      const activityEvents: Array<Record<string, unknown>> = [];
      if (activityResult.error) {
        errors.push(activityResult.error);
      } else {
        for (const event of activityResult.events) {
          const status = event.status?.value ?? "";
          const op = event.operationName?.value ?? "";
          if (status === "Failed" || op.includes("write") || op.includes("deploy") || op.includes("restart") || op.includes("delete") || op.includes("action")) {
            activityEvents.push({
              time: event.eventTimestamp?.toISOString(),
              operation: event.operationName?.localizedValue ?? op,
              status,
              caller: event.caller,
            });
          }
        }
      }

      // ── 7. Process metrics — extract summaries with recent values ──────
      interface MetricSummary {
        name: string;
        source: string;
        unit: string;
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
        const meta = metricPromises[i];
        if (result.error) { errors.push(result.error); continue; }
        if (!result.data) continue;

        for (const metric of result.data.metrics) {
          for (const ts of metric.timeseries) {
            if (!ts.data) continue;
            const points = ts.data
              .filter((dp) => dp.average !== undefined || dp.maximum !== undefined || dp.total !== undefined)
              .map((dp) => ({
                time: (dp as unknown as { timeStamp: Date }).timeStamp?.toISOString() ?? "",
                avg: dp.average ?? dp.total ?? 0,
                max: dp.maximum ?? dp.average ?? dp.total ?? 0,
              }));

            if (points.length === 0) continue;

            const avgs = points.map((p) => p.avg);
            const maxes = points.map((p) => p.max);

            const defUnit = metricDefs.definitions.find((d) => d.name === metric.name)?.unit ?? metric.unit ?? "Unspecified";

            metricSummaries.push({
              name: metric.name,
              source: meta?.label ?? "unknown",
              unit: defUnit,
              current: Math.round(avgs[avgs.length - 1] * 100) / 100,
              max: Math.round(Math.max(...maxes) * 100) / 100,
              avg: Math.round((avgs.reduce((a, b) => a + b, 0) / avgs.length) * 100) / 100,
              min: Math.round(Math.min(...avgs) * 100) / 100,
              dataPoints: points.length,
              recentValues: points.slice(-6).map((p) => ({ time: p.time, value: Math.round(p.avg * 100) / 100 })),
            });
          }
        }
      }

      // ── 8. Log Analytics — failed requests, exceptions, dependency failures
      interface LogData {
        workspace: string;
        failedRequests: Array<{ operation: string; statusCode: string; count: number; avgDurationMs: number }>;
        exceptions: Array<{ type: string; message: string; count: number }>;
        dependencyFailures: Array<{ target: string; type: string; resultCode: string; count: number; avgDurationMs: number }>;
      }
      let logData: LogData | null = null;

      if (resolvedRG) {
        const wsResult = await discoverWorkspaces(subscription, resolvedRG);
        if (wsResult.workspaces.length > 0) {
          const ws = wsResult.workspaces[0];

          // Use absolute time filters for incident window precision
          const timeFilter = `TimeGenerated >= datetime('${windowStart.toISOString()}') and TimeGenerated <= datetime('${windowEnd.toISOString()}')`;

          const [reqResult, excResult, depFail] = await Promise.all([
            queryLogAnalytics(ws.workspaceId, `AppRequests
| where ${timeFilter}
| where Success == false
| summarize Count = count(), AvgDuration = round(avg(DurationMs), 1) by OperationName, ResultCode
| order by Count desc
| take 10`, hoursBack),
            queryLogAnalytics(ws.workspaceId, `AppExceptions
| where ${timeFilter}
| summarize Count = count() by ExceptionType, OuterMessage
| order by Count desc
| take 10`, hoursBack),
            queryLogAnalytics(ws.workspaceId, `AppDependencies
| where ${timeFilter}
| where Success == false
| summarize Count = count(), AvgDuration = round(avg(DurationMs), 1) by Target, DependencyType = Type, ResultCode
| order by Count desc
| take 10`, hoursBack),
          ]);

          if (reqResult.error) errors.push(reqResult.error);
          if (excResult.error) errors.push(excResult.error);
          if (depFail.error) errors.push(depFail.error);

          logData = {
            workspace: ws.workspaceName,
            failedRequests: (reqResult.tables?.[0]?.rows ?? []).map((r) => ({
              operation: String(r[0] ?? ""), statusCode: String(r[1] ?? ""),
              count: Number(r[2]) || 0, avgDurationMs: Number(r[3]) || 0,
            })),
            exceptions: (excResult.tables?.[0]?.rows ?? []).map((r) => ({
              type: String(r[0] ?? ""), message: String(r[1] ?? ""),
              count: Number(r[2]) || 0,
            })),
            dependencyFailures: (depFail.tables?.[0]?.rows ?? []).map((r) => ({
              target: String(r[0] ?? ""), type: String(r[1] ?? ""),
              resultCode: String(r[2] ?? ""), count: Number(r[3]) || 0,
              avgDurationMs: Number(r[4]) || 0,
            })),
          };
        }
      }

      // ── 9. Check dependencies — actual dependency types only ───────────
      interface DepHealth { name: string; type: string; health: string }
      const dependencies: DepHealth[] = [];

      if (resolvedRG) {
        const typeFilter = DEPENDENCY_TYPES.map((t) => `'${t}'`).join(", ");
        const depQuery = `Resources
| where resourceGroup =~ '${resolvedRG}'
| where name != '${resourceName}'
| where type in~ (${typeFilter})
| project id, name, type
| take 20`;
        const depResult = await queryResourceGraph([subscription], depQuery);
        if (depResult.error) errors.push(depResult.error);

        const deps = depResult.resources.map((d) => ({
          id: d.id as string,
          name: d.name as string,
          type: d.type as string,
        }));

        if (deps.length > 0) {
          const healthChecks = await batchExecute(
            deps.map((dep) => async () => {
              const h = await getResourceHealth(subscription, dep.id);
              return {
                name: dep.name,
                type: dep.type,
                health: h.statuses[0]?.properties?.availabilityState ?? "Unknown",
              };
            }),
            5
          );
          dependencies.push(...healthChecks);
        }
      }

      // ── 10. Build response — raw data, no opinions ─────────────────────
      const response: Record<string, unknown> = {
        resource: resourceName,
        resourceType,
        resourceGroup: resolvedRG,
        currentHealth,
        incidentWindow: {
          start: windowStart.toISOString(),
          end: windowEnd.toISOString(),
          durationHours: Math.round(hoursBack * 100) / 100,
        },
        generatedAt: now.toISOString(),
      };

      if (healthDetails) response.healthDetails = healthDetails;

      // Metrics
      if (metricSummaries.length > 0) {
        response.metrics = metricSummaries;
      } else if (selectedMetrics.length === 0 && metricDefs.definitions.length === 0) {
        response.metrics = "This resource type does not emit Azure Monitor metrics.";
      } else {
        response.metrics = `Metrics requested (${selectedMetrics.join(", ")}) but no data returned for the incident window.`;
      }

      if (metricDefs.definitions.length > MAX_METRICS) {
        response.additionalMetricsAvailable = metricDefs.definitions.slice(MAX_METRICS).map((d) => d.name);
      }

      // Activity log
      if (activityEvents.length > 0) {
        response.activityLog = activityEvents;
      } else {
        response.activityLog = "No write operations or failures in the activity log for this window.";
      }

      // Log Analytics
      if (logData) {
        if (logData.failedRequests.length > 0 || logData.exceptions.length > 0 || logData.dependencyFailures.length > 0) {
          response.logAnalytics = logData;
        } else {
          response.logAnalytics = { workspace: logData.workspace, summary: "No failed requests, exceptions, or dependency failures found in the incident window." };
        }
      }

      // Dependencies
      if (dependencies.length > 0) {
        response.dependencies = dependencies;
      }

      // API errors
      if (errors.length > 0) {
        response.apiErrors = errors.map((e) => `${e.code}: ${e.message}`);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
