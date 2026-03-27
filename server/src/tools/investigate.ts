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
// The investigate tool auto-resolves these so users don't need to know.
const PARENT_METRIC_RESOURCES: Record<string, { property: string; label: string }> = {
  "microsoft.web/sites": { property: "properties.serverFarmId", label: "App Service Plan" },
};

// Max metrics to pull per resource to avoid huge responses
const MAX_METRICS = 15;

export function registerInvestigate(server: McpServer): void {
  server.tool(
    "azdoctor_investigate",
    "Investigate any Azure resource. Dynamically discovers what metrics, logs, and dependencies are available — no hardcoded resource knowledge. Returns comprehensive raw diagnostic data for AI analysis.",
    {
      resource: z.string().describe("Resource name or full Azure resource ID"),
      subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z.string().optional().describe("Resource group name (helps resolve resource ID faster)"),
      timeframeHours: z.number().default(24).describe("How many hours back to investigate"),
      startTime: z.string().optional().describe("ISO timestamp for incident start (e.g., 2026-03-25T14:00:00Z). Overrides timeframeHours."),
      endTime: z.string().optional().describe("ISO timestamp for incident end. Defaults to now if startTime is provided."),
      symptom: z.string().optional().describe('User-described symptom (e.g., "slow", "500 errors", "unreachable")'),
    },
    async ({ resource, subscription: subParam, resourceGroup, timeframeHours, startTime, endTime, symptom }) => {
      const subscription = await resolveSubscription(subParam);
      const errors: AzureError[] = [];

      // Compute effective time window
      let effectiveHours = timeframeHours;
      if (startTime) {
        const start = new Date(startTime);
        const end = endTime ? new Date(endTime) : new Date();
        effectiveHours = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (60 * 60 * 1000)));
      }

      // ── 1. Resolve resource ──────────────────────────────────────────
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

      // ── 2. Discover available metrics dynamically ────────────────────
      // Ask Azure what metrics this resource emits — no hardcoded lists
      const metricDefs = await listMetricDefinitions(resourceId);
      if (metricDefs.error) errors.push(metricDefs.error);

      // Pick the most useful metrics (prioritize percentage, count, error, time metrics)
      const priorityPatterns = [/percent/i, /cpu/i, /memory/i, /error/i, /5xx/i, /4xx/i, /fail/i, /latency/i, /response.*time/i, /request/i, /connection/i, /dtu/i, /throughput/i, /availability/i, /queue/i, /count/i];
      const sortedDefs = [...metricDefs.definitions].sort((a, b) => {
        const aScore = priorityPatterns.findIndex((p) => p.test(a.name));
        const bScore = priorityPatterns.findIndex((p) => p.test(b.name));
        const aRank = aScore === -1 ? 999 : aScore;
        const bRank = bScore === -1 ? 999 : bScore;
        return aRank - bRank;
      });
      const selectedMetrics = sortedDefs.slice(0, MAX_METRICS).map((d) => d.name);

      // Also check if this resource type has metrics on a parent (e.g., App Service → Plan)
      const parentConfig = PARENT_METRIC_RESOURCES[resourceType.toLowerCase()];
      let parentResourceId: string | null = null;
      let parentLabel: string | null = null;

      if (parentConfig) {
        // Resolve parent resource ID from the resource's properties
        const propPath = parentConfig.property.replace("properties.", "");
        const parentId = resourceProperties[propPath] as string | undefined;
        if (parentId) {
          parentResourceId = parentId;
          parentLabel = parentConfig.label;
        } else {
          // Fallback: query Resource Graph for the property
          const parentQuery = `Resources | where type =~ '${resourceType}' and name =~ '${resourceName}' | project parentId = ${parentConfig.property} | take 1`;
          const parentResult = await queryResourceGraph([subscription], parentQuery);
          if (parentResult.resources.length > 0) {
            parentResourceId = parentResult.resources[0]["parentId"] as string ?? null;
            parentLabel = parentConfig.label;
          }
        }
      }

      // Discover parent metrics too
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

      // ── 3. Gather ALL signals in parallel ────────────────────────────
      const metricPromises: Array<{ label: string; resourceId: string; promise: ReturnType<typeof getMetrics> }> = [];

      if (selectedMetrics.length > 0) {
        metricPromises.push({
          label: resourceName,
          resourceId,
          promise: getMetrics(resourceId, selectedMetrics, effectiveHours, "PT5M"),
        });
      }

      if (parentResourceId && parentMetricNames.length > 0) {
        metricPromises.push({
          label: `${parentLabel ?? "parent"}`,
          resourceId: parentResourceId,
          promise: getMetrics(parentResourceId, parentMetricNames, effectiveHours, "PT5M"),
        });
      }

      const [healthResult, activityResult, ...metricResults] = await Promise.all([
        getResourceHealth(subscription, resourceId),
        getActivityLogs(subscription, effectiveHours, resourceId),
        ...metricPromises.map((m) => m.promise),
      ]);

      // ── 4. Process health ────────────────────────────────────────────
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

      // ── 5. Process activity log — only notable events ────────────────
      const recentChanges: Array<Record<string, unknown>> = [];
      if (activityResult.error) {
        errors.push(activityResult.error);
      } else {
        for (const event of activityResult.events) {
          const status = event.status?.value ?? "";
          const op = event.operationName?.value ?? "";
          if (status === "Failed" || op.includes("write") || op.includes("deploy") || op.includes("restart") || op.includes("delete") || op.includes("action")) {
            recentChanges.push({
              time: event.eventTimestamp?.toISOString(),
              operation: event.operationName?.localizedValue ?? op,
              status,
              caller: event.caller,
            });
          }
        }
      }

      // ── 6. Process metrics — extract summaries with recent values ────
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

            // Find the unit from definitions
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

      // ── 7. Discover ACTUAL dependencies ─────────────────────────────
      // Don't just grab everything in the RG — find resources this resource
      // actually connects to based on its configuration.
      interface DepHealth { name: string; type: string; health: string; relationship: string }
      const dependencies: DepHealth[] = [];

      if (resolvedRG) {
        const depResourceIds: Array<{ id: string; name: string; type: string; relationship: string }> = [];

        if (resourceType.toLowerCase() === "microsoft.web/sites") {
          // For App Services: check app settings and connection strings for references
          // to SQL servers, Redis, Cosmos, Storage, etc.
          const configQuery = `Resources
| where type =~ 'microsoft.web/sites' and name =~ '${resourceName}' and resourceGroup =~ '${resolvedRG}'
| project siteConfig = properties.siteConfig, serverFarmId = properties.serverFarmId
| take 1`;
          const configResult = await queryResourceGraph([subscription], configQuery);

          // Extract referenced resource names from app settings
          const referencedNames = new Set<string>();
          if (configResult.resources.length > 0) {
            const config = configResult.resources[0];
            const siteConfig = config["siteConfig"] as Record<string, unknown> | undefined;
            const appSettings = siteConfig?.["appSettings"] as Array<{ name: string; value: string }> | undefined;

            // Scan app settings values for resource references
            if (Array.isArray(appSettings)) {
              for (const setting of appSettings) {
                const val = String(setting.value ?? "");
                // Extract server names from connection strings
                const serverMatch = val.match(/(?:Server|Data Source|AccountEndpoint)=(?:tcp:)?([^;,]+)/i);
                if (serverMatch) {
                  // Extract just the hostname prefix (e.g., "sql-azdemo-prod-30bf1e4b" from "sql-azdemo-prod-30bf1e4b.database.windows.net")
                  const host = serverMatch[1].split(".")[0];
                  referencedNames.add(host.toLowerCase());
                }
                // Extract Redis host
                const redisMatch = val.match(/([^.]+)\.redis\.cache\.windows\.net/i);
                if (redisMatch) referencedNames.add(redisMatch[1].toLowerCase());
                // Extract storage account
                const storageMatch = val.match(/([^.]+)\.blob\.core\.windows\.net/i);
                if (storageMatch) referencedNames.add(storageMatch[1].toLowerCase());
                // Extract Cosmos
                const cosmosMatch = val.match(/([^.]+)\.documents\.azure\.com/i);
                if (cosmosMatch) referencedNames.add(cosmosMatch[1].toLowerCase());
              }
            }
          }

          if (referencedNames.size > 0) {
            // Find the actual resources matching these names
            const nameFilter = Array.from(referencedNames).map((n) => `name =~ '${n}'`).join(" or ");
            const refQuery = `Resources | where (${nameFilter}) | project id, name, type | take 20`;
            const refResult = await queryResourceGraph([subscription], refQuery);
            if (refResult.error) errors.push(refResult.error);
            for (const dep of refResult.resources) {
              depResourceIds.push({
                id: dep.id as string, name: dep.name as string,
                type: dep.type as string, relationship: "referenced in app settings",
              });
            }

            // Also find child resources (e.g., SQL databases under the referenced server)
            for (const dep of [...depResourceIds]) {
              if ((dep.type as string).toLowerCase() === "microsoft.sql/servers") {
                const dbQuery = `Resources | where type =~ 'microsoft.sql/servers/databases' and name != 'master' and resourceGroup =~ '${resolvedRG}' and id startswith '${dep.id}' | project id, name, type`;
                const dbResult = await queryResourceGraph([subscription], dbQuery);
                for (const db of dbResult.resources) {
                  depResourceIds.push({
                    id: db.id as string, name: db.name as string,
                    type: db.type as string, relationship: `database on ${dep.name}`,
                  });
                }
              }
            }
          }

          // If no references found in app settings, fall back to data resources in RG
          if (depResourceIds.length === 0) {
            const fallbackQuery = `Resources
| where resourceGroup =~ '${resolvedRG}'
| where name != '${resourceName}'
| where type in~ ('microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.documentdb/databaseaccounts', 'microsoft.cache/redis', 'microsoft.storage/storageaccounts', 'microsoft.keyvault/vaults', 'microsoft.servicebus/namespaces', 'microsoft.eventhub/namespaces')
| where name != 'master'
| project id, name, type
| take 10`;
            const fallbackResult = await queryResourceGraph([subscription], fallbackQuery);
            if (fallbackResult.error) errors.push(fallbackResult.error);
            for (const dep of fallbackResult.resources) {
              depResourceIds.push({
                id: dep.id as string, name: dep.name as string,
                type: dep.type as string, relationship: "in same resource group",
              });
            }
          }
        } else {
          // For non-App Service resources: find data/compute resources in the same RG
          const depQuery = `Resources
| where resourceGroup =~ '${resolvedRG}'
| where name != '${resourceName}'
| where type in~ ('microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.documentdb/databaseaccounts', 'microsoft.cache/redis', 'microsoft.storage/storageaccounts', 'microsoft.keyvault/vaults', 'microsoft.web/sites', 'microsoft.compute/virtualmachines', 'microsoft.containerservice/managedclusters')
| where name != 'master'
| project id, name, type
| take 10`;
          const depResult = await queryResourceGraph([subscription], depQuery);
          if (depResult.error) errors.push(depResult.error);
          for (const dep of depResult.resources) {
            depResourceIds.push({
              id: dep.id as string, name: dep.name as string,
              type: dep.type as string, relationship: "in same resource group",
            });
          }
        }

        // Health check discovered dependencies
        if (depResourceIds.length > 0) {
          const healthChecks = await batchExecute(
            depResourceIds.map((dep) => async () => {
              const h = await getResourceHealth(subscription, dep.id);
              return {
                name: dep.name,
                type: dep.type,
                health: h.statuses[0]?.properties?.availabilityState ?? "Unknown",
                relationship: dep.relationship,
              };
            }),
            5
          );
          dependencies.push(...healthChecks);
        }
      }

      // ── 8. Log Analytics — errors, exceptions, dependency failures ───
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

          const [reqResult, excResult, depFail] = await Promise.all([
            queryLogAnalytics(ws.workspaceId, `AppRequests
| where TimeGenerated > ago(${effectiveHours}h)
| where Success == false
| summarize Count = count(), AvgDuration = round(avg(DurationMs), 1) by OperationName, ResultCode
| order by Count desc
| take 10`, effectiveHours),
            queryLogAnalytics(ws.workspaceId, `AppExceptions
| where TimeGenerated > ago(${effectiveHours}h)
| summarize Count = count() by ExceptionType, OuterMessage
| order by Count desc
| take 10`, effectiveHours),
            queryLogAnalytics(ws.workspaceId, `AppDependencies
| where TimeGenerated > ago(${effectiveHours}h)
| where Success == false
| summarize Count = count(), AvgDuration = round(avg(DurationMs), 1) by Target, DependencyType = Type, ResultCode
| order by Count desc
| take 10`, effectiveHours),
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

      // ── 8b. Resource-specific Log Analytics queries ─────────────────
      // For AKS: Container Insights (pod status, OOMKills, container logs)
      // For SQL: Diagnostic tables (query stats, wait stats, deadlocks)
      let resourceSpecificLogs: Record<string, unknown> | null = null;

      if (resolvedRG) {
        const wsResult2 = logData ? null : await discoverWorkspaces(subscription, resolvedRG);
        const wsId = logData
          ? (await discoverWorkspaces(subscription, resolvedRG)).workspaces[0]?.workspaceId
          : wsResult2?.workspaces[0]?.workspaceId;

        if (wsId) {
          const typeLower = resourceType.toLowerCase();

          if (typeLower === "microsoft.containerservice/managedclusters") {
            // AKS Container Insights queries
            const [podStatus, oomKills, containerRestarts, nodePerf] = await Promise.all([
              queryLogAnalytics(wsId, `KubePodInventory
| where TimeGenerated > ago(${effectiveHours}h)
| where ClusterName =~ '${resourceName}'
| where PodStatus in ('Failed', 'Unknown', 'Pending')
| summarize Count = count() by PodStatus, Namespace, Name
| order by Count desc
| take 20`, effectiveHours),
              queryLogAnalytics(wsId, `KubeEvents
| where TimeGenerated > ago(${effectiveHours}h)
| where ClusterName =~ '${resourceName}'
| where Reason in ('OOMKilling', 'BackOff', 'Unhealthy', 'FailedScheduling', 'Evicted')
| summarize Count = count() by Reason, Namespace, Name, Message
| order by Count desc
| take 20`, effectiveHours),
              queryLogAnalytics(wsId, `ContainerInventory
| where TimeGenerated > ago(${effectiveHours}h)
| where ContainerState == 'Failed' or RestartCount > 3
| summarize MaxRestarts = max(RestartCount), arg_max(TimeGenerated, ContainerState, ExitCode) by ContainerHostname, Name, Image
| order by MaxRestarts desc
| take 15`, effectiveHours),
              queryLogAnalytics(wsId, `InsightsMetrics
| where TimeGenerated > ago(${effectiveHours}h)
| where Namespace == 'container.azm.ms/kubestate'
| where Name in ('restartingContainerCount', 'oomKilledContainerCount', 'podReadyPercentage')
| summarize Value = avg(Val) by Name, bin(TimeGenerated, 5m)
| order by TimeGenerated desc
| take 50`, effectiveHours),
            ]);

            resourceSpecificLogs = {
              source: "Container Insights",
              unhealthyPods: (podStatus.tables?.[0]?.rows ?? []).map((r) => ({
                status: String(r[0] ?? ""), namespace: String(r[1] ?? ""),
                pod: String(r[2] ?? ""), count: Number(r[3]) || 0,
              })),
              kubeEvents: (oomKills.tables?.[0]?.rows ?? []).map((r) => ({
                reason: String(r[0] ?? ""), namespace: String(r[1] ?? ""),
                resource: String(r[2] ?? ""), message: String(r[3] ?? ""),
                count: Number(r[4]) || 0,
              })),
              failedContainers: (containerRestarts.tables?.[0]?.rows ?? []).map((r) => ({
                host: String(r[0] ?? ""), container: String(r[1] ?? ""),
                image: String(r[2] ?? ""), maxRestarts: Number(r[3]) || 0,
                lastState: String(r[4] ?? ""), exitCode: Number(r[5]) || 0,
              })),
            };
            if (podStatus.error) errors.push(podStatus.error);
            if (oomKills.error) errors.push(oomKills.error);
            if (containerRestarts.error) errors.push(containerRestarts.error);

          } else if (typeLower.includes("microsoft.sql/") || typeLower.includes("microsoft.dbforpostgresql/")) {
            // SQL / PostgreSQL diagnostic queries
            const [queryStats, waitStats, deadlocks] = await Promise.all([
              queryLogAnalytics(wsId, `AzureDiagnostics
| where TimeGenerated > ago(${effectiveHours}h)
| where ResourceProvider == 'MICROSOFT.SQL' or ResourceProvider == 'MICROSOFT.DBFORPOSTGRESQL'
| where Category == 'QueryStoreRuntimeStatistics' or Category == 'QueryStoreWaitStatistics' or Category == 'PostgreSQLLogs'
| summarize Count = count() by Category, Resource
| order by Count desc
| take 10`, effectiveHours),
              queryLogAnalytics(wsId, `AzureDiagnostics
| where TimeGenerated > ago(${effectiveHours}h)
| where Category == 'SQLSecurityAuditEvents' or Category == 'Errors' or Category == 'Timeouts'
| summarize Count = count() by Category, Resource
| order by Count desc
| take 10`, effectiveHours),
              queryLogAnalytics(wsId, `AzureDiagnostics
| where TimeGenerated > ago(${effectiveHours}h)
| where Category == 'Deadlocks' or Category == 'Blocks'
| project TimeGenerated, Category, Resource, deadlock_xml_s, lock_mode_s, blocked_process_xml_s
| order by TimeGenerated desc
| take 10`, effectiveHours),
            ]);

            const hasData = [queryStats, waitStats, deadlocks].some(
              (r) => (r.tables?.[0]?.rows?.length ?? 0) > 0
            );

            if (hasData) {
              resourceSpecificLogs = {
                source: "SQL/PostgreSQL Diagnostics",
                queryStats: (queryStats.tables?.[0]?.rows ?? []).map((r) => ({
                  category: String(r[0] ?? ""), resource: String(r[1] ?? ""),
                  count: Number(r[2]) || 0,
                })),
                errors: (waitStats.tables?.[0]?.rows ?? []).map((r) => ({
                  category: String(r[0] ?? ""), resource: String(r[1] ?? ""),
                  count: Number(r[2]) || 0,
                })),
                deadlocks: (deadlocks.tables?.[0]?.rows ?? []).map((r) => ({
                  time: String(r[0] ?? ""), category: String(r[1] ?? ""),
                  resource: String(r[2] ?? ""),
                })),
              };
            }
            if (queryStats.error) errors.push(queryStats.error);
            if (waitStats.error) errors.push(waitStats.error);
            if (deadlocks.error) errors.push(deadlocks.error);
          }
        }
      }

      // ── 9. Build response — raw data, no opinions ────────────────────
      const response: Record<string, unknown> = {
        resource: resourceName,
        resourceType,
        resourceGroup: resolvedRG,
        currentHealth,
        investigationWindow: startTime
          ? { start: startTime, end: endTime ?? new Date().toISOString(), hours: effectiveHours }
          : { hours: effectiveHours },
      };

      if (healthDetails) response.healthDetails = healthDetails;
      if (symptom) response.reportedSymptom = symptom;

      // Metrics — the core diagnostic data
      if (metricSummaries.length > 0) {
        response.metrics = metricSummaries;
      } else if (selectedMetrics.length === 0 && metricDefs.definitions.length === 0) {
        response.metrics = "This resource type does not emit Azure Monitor metrics.";
      } else {
        response.metrics = `Metrics requested (${selectedMetrics.join(", ")}) but no data returned for the ${effectiveHours}h window.`;
      }

      // Available metrics not pulled (for context)
      if (metricDefs.definitions.length > MAX_METRICS) {
        response.additionalMetricsAvailable = metricDefs.definitions.slice(MAX_METRICS).map((d) => d.name);
      }

      // Activity log
      if (recentChanges.length > 0) {
        response.recentChanges = recentChanges;
      } else {
        response.recentChanges = "No write operations or failures in the activity log.";
      }

      // Log Analytics
      if (logData) {
        if (logData.failedRequests.length > 0 || logData.exceptions.length > 0 || logData.dependencyFailures.length > 0) {
          response.logAnalytics = logData;
        } else {
          response.logAnalytics = { workspace: logData.workspace, summary: "No failed requests, exceptions, or dependency failures found." };
        }
      }

      // Resource-specific diagnostics (Container Insights, SQL diagnostics, etc.)
      if (resourceSpecificLogs) {
        response.resourceDiagnostics = resourceSpecificLogs;
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
