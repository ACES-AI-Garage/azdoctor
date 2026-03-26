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
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";
import {
  renderTopology,
  renderMermaidTopology,
  renderMermaidTimeline,
} from "../utils/formatters.js";
import type { TopologyNode } from "../utils/formatters.js";

// Resources where key metrics live on a parent resource, not the resource itself.
const PARENT_METRIC_RESOURCES: Record<string, { property: string; label: string }> = {
  "microsoft.web/sites": { property: "properties.serverFarmId", label: "App Service Plan" },
};

// Max metrics to pull per resource to keep diagrams readable
const MAX_METRICS = 15;

// Priority patterns for selecting the most useful metrics
const METRIC_PRIORITY_PATTERNS = [
  /percent/i, /cpu/i, /memory/i, /error/i, /5xx/i, /4xx/i, /fail/i,
  /latency/i, /response.*time/i, /request/i, /connection/i, /dtu/i,
  /throughput/i, /availability/i, /queue/i, /count/i,
];

export function registerDiagram(server: McpServer): void {
  server.tool(
    "azdoctor_diagram",
    "Generate Mermaid diagrams from investigation data. Produces dependency topology diagrams and incident timeline diagrams that render in GitHub, VS Code, and documentation tools.",
    {
      resource: z.string().describe("Resource name or full Azure resource ID"),
      subscription: z
        .string()
        .optional()
        .describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z
        .string()
        .optional()
        .describe("Resource group name (helps resolve resource ID faster)"),
      diagramType: z
        .enum(["topology", "timeline", "both"])
        .default("both")
        .describe("Type of diagram to generate"),
      timeframeHours: z
        .number()
        .default(24)
        .describe("Lookback window for timeline diagram"),
    },
    async ({
      resource,
      subscription: subParam,
      resourceGroup,
      diagramType,
      timeframeHours,
    }) => {
      const subscription = await resolveSubscription(subParam);
      const errors: AzureError[] = [];

      // ── 1. Resolve resource ──────────────────────────────────────────
      let resourceId = resource;
      let resourceType = "Unknown";
      let resourceName = resource;
      let resolvedResourceGroup = resourceGroup;
      let resourceProperties: Record<string, unknown> = {};

      if (!resource.startsWith("/subscriptions/")) {
        const rgFilter = resourceGroup
          ? `| where resourceGroup =~ '${resourceGroup}'`
          : "";
        const resolveQuery = `Resources | where name =~ '${resource}' ${rgFilter} | project id, name, type, location, resourceGroup, properties | take 1`;
        const resolved = await queryResourceGraph([subscription], resolveQuery);
        if (resolved.resources.length > 0) {
          const r = resolved.resources[0];
          resourceId = (r.id as string) ?? resource;
          resourceType = (r.type as string) ?? "Unknown";
          resourceName = (r.name as string) ?? resource;
          resolvedResourceGroup = (r.resourceGroup as string) ?? resourceGroup;
          resourceProperties = (r.properties as Record<string, unknown>) ?? {};
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

      // ── 2. Build topology if requested ───────────────────────────────
      let topologyMermaid: string | undefined;
      let topologyAscii: string | undefined;
      let dependencyCount = 0;

      if (diagramType === "topology" || diagramType === "both") {
        // Get root health
        const rootHealthResult = await getResourceHealth(subscription, resourceId);
        const rootHealth =
          (rootHealthResult.statuses[0]?.properties?.availabilityState as TopologyNode["health"]) ??
          "Unknown";
        if (rootHealthResult.error) {
          errors.push(rootHealthResult.error);
        }

        const rootNode: TopologyNode = {
          name: resourceName,
          type: resourceType,
          health: rootHealth,
          isRoot: true,
        };

        // Discover actual dependencies (same pattern as investigate.ts)
        const depNodes: TopologyNode[] = [];
        if (resolvedResourceGroup) {
          const depResourceIds: Array<{ id: string; name: string; type: string }> = [];

          if (resourceType.toLowerCase() === "microsoft.web/sites") {
            // For App Services: parse app settings for connection references
            const configQuery = `Resources
| where type =~ 'microsoft.web/sites' and name =~ '${resourceName}' and resourceGroup =~ '${resolvedResourceGroup}'
| project siteConfig = properties.siteConfig, serverFarmId = properties.serverFarmId
| take 1`;
            const configResult = await queryResourceGraph([subscription], configQuery);

            const referencedNames = new Set<string>();
            if (configResult.resources.length > 0) {
              const config = configResult.resources[0];
              const siteConfig = config["siteConfig"] as Record<string, unknown> | undefined;
              const appSettings = siteConfig?.["appSettings"] as Array<{ name: string; value: string }> | undefined;

              if (Array.isArray(appSettings)) {
                for (const setting of appSettings) {
                  const val = String(setting.value ?? "");
                  // Extract server names from connection strings
                  const serverMatch = val.match(/(?:Server|Data Source|AccountEndpoint)=(?:tcp:)?([^;,]+)/i);
                  if (serverMatch) {
                    const host = serverMatch[1].split(".")[0];
                    referencedNames.add(host.toLowerCase());
                  }
                  // Redis
                  const redisMatch = val.match(/([^.]+)\.redis\.cache\.windows\.net/i);
                  if (redisMatch) referencedNames.add(redisMatch[1].toLowerCase());
                  // Storage
                  const storageMatch = val.match(/([^.]+)\.blob\.core\.windows\.net/i);
                  if (storageMatch) referencedNames.add(storageMatch[1].toLowerCase());
                  // Cosmos
                  const cosmosMatch = val.match(/([^.]+)\.documents\.azure\.com/i);
                  if (cosmosMatch) referencedNames.add(cosmosMatch[1].toLowerCase());
                }
              }
            }
            if (configResult.error) errors.push(configResult.error);

            if (referencedNames.size > 0) {
              const nameFilter = Array.from(referencedNames).map((n) => `name =~ '${n}'`).join(" or ");
              const refQuery = `Resources | where (${nameFilter}) | project id, name, type | take 20`;
              const refResult = await queryResourceGraph([subscription], refQuery);
              if (refResult.error) errors.push(refResult.error);
              for (const dep of refResult.resources) {
                depResourceIds.push({
                  id: dep.id as string,
                  name: dep.name as string,
                  type: dep.type as string,
                });
              }

              // Find child resources (e.g., SQL databases under referenced server)
              for (const dep of [...depResourceIds]) {
                if ((dep.type as string).toLowerCase() === "microsoft.sql/servers") {
                  const dbQuery = `Resources | where type =~ 'microsoft.sql/servers/databases' and name != 'master' and resourceGroup =~ '${resolvedResourceGroup}' and id startswith '${dep.id}' | project id, name, type`;
                  const dbResult = await queryResourceGraph([subscription], dbQuery);
                  for (const db of dbResult.resources) {
                    depResourceIds.push({
                      id: db.id as string,
                      name: db.name as string,
                      type: db.type as string,
                    });
                  }
                }
              }
            }

            // Fallback: data resources in same RG
            if (depResourceIds.length === 0) {
              const fallbackQuery = `Resources
| where resourceGroup =~ '${resolvedResourceGroup}'
| where name != '${resourceName}'
| where type in~ ('microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.documentdb/databaseaccounts', 'microsoft.cache/redis', 'microsoft.storage/storageaccounts', 'microsoft.keyvault/vaults', 'microsoft.servicebus/namespaces', 'microsoft.eventhub/namespaces')
| where name != 'master'
| project id, name, type
| take 10`;
              const fallbackResult = await queryResourceGraph([subscription], fallbackQuery);
              if (fallbackResult.error) errors.push(fallbackResult.error);
              for (const dep of fallbackResult.resources) {
                depResourceIds.push({
                  id: dep.id as string,
                  name: dep.name as string,
                  type: dep.type as string,
                });
              }
            }
          } else {
            // For non-App Service resources: find data/compute resources in the same RG
            const depQuery = `Resources
| where resourceGroup =~ '${resolvedResourceGroup}'
| where name != '${resourceName}'
| where type in~ ('microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.documentdb/databaseaccounts', 'microsoft.cache/redis', 'microsoft.storage/storageaccounts', 'microsoft.keyvault/vaults', 'microsoft.web/sites', 'microsoft.compute/virtualmachines', 'microsoft.containerservice/managedclusters')
| where name != 'master'
| project id, name, type
| take 10`;
            const depResult = await queryResourceGraph([subscription], depQuery);
            if (depResult.error) errors.push(depResult.error);
            for (const dep of depResult.resources) {
              depResourceIds.push({
                id: dep.id as string,
                name: dep.name as string,
                type: dep.type as string,
              });
            }
          }

          // Check health of each dependency
          if (depResourceIds.length > 0) {
            const healthChecks = await batchExecute(
              depResourceIds.map((dep) => async () => {
                const depHealth = await getResourceHealth(subscription, dep.id);
                const depState =
                  (depHealth.statuses[0]?.properties?.availabilityState as TopologyNode["health"]) ??
                  "Unknown";
                return { dep, depState };
              }),
              5
            );

            for (const { dep, depState } of healthChecks) {
              depNodes.push({
                name: dep.name,
                type: dep.type,
                health: depState,
                isRoot: false,
              });
            }
          }
        }

        dependencyCount = depNodes.length;
        topologyMermaid = renderMermaidTopology(rootNode, depNodes);
        topologyAscii = renderTopology(rootNode, depNodes);
      }

      // ── 3. Build timeline if requested ───────────────────────────────
      let timelineMermaid: string | undefined;
      let eventCount = 0;

      if (diagramType === "timeline" || diagramType === "both") {
        interface TimelineEvent {
          time: string;
          event: string;
          source: string;
          severity: "critical" | "warning" | "info";
        }
        const allEvents: TimelineEvent[] = [];

        // Discover metrics dynamically via listMetricDefinitions
        const metricDefs = await listMetricDefinitions(resourceId);
        if (metricDefs.error) errors.push(metricDefs.error);

        const sortedDefs = [...metricDefs.definitions].sort((a, b) => {
          const aScore = METRIC_PRIORITY_PATTERNS.findIndex((p) => p.test(a.name));
          const bScore = METRIC_PRIORITY_PATTERNS.findIndex((p) => p.test(b.name));
          return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
        });
        const selectedMetrics = sortedDefs.slice(0, MAX_METRICS).map((d) => d.name);

        // Resolve parent resource for metrics (e.g., App Service Plan for CPU/Memory)
        const parentConfig = PARENT_METRIC_RESOURCES[resourceType.toLowerCase()];
        let parentResourceId: string | null = null;
        let parentLabel: string | null = null;
        let parentMetricNames: string[] = [];

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
              parentResourceId = (parentResult.resources[0]["parentId"] as string) ?? null;
              parentLabel = parentConfig.label;
            }
          }

          if (parentResourceId) {
            const parentDefs = await listMetricDefinitions(parentResourceId);
            if (parentDefs.error) errors.push(parentDefs.error);
            const parentSorted = [...parentDefs.definitions].sort((a, b) => {
              const aScore = METRIC_PRIORITY_PATTERNS.findIndex((p) => p.test(a.name));
              const bScore = METRIC_PRIORITY_PATTERNS.findIndex((p) => p.test(b.name));
              return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
            });
            parentMetricNames = parentSorted.slice(0, MAX_METRICS).map((d) => d.name);
          }
        }

        // Build metric fetch promises
        const metricPromises: Array<{ label: string; promise: ReturnType<typeof getMetrics> }> = [];
        if (selectedMetrics.length > 0) {
          metricPromises.push({
            label: resourceName,
            promise: getMetrics(resourceId, selectedMetrics, timeframeHours, "PT5M"),
          });
        }
        if (parentResourceId && parentMetricNames.length > 0) {
          metricPromises.push({
            label: parentLabel ?? "parent",
            promise: getMetrics(parentResourceId, parentMetricNames, timeframeHours, "PT5M"),
          });
        }

        // Gather health, activity log, and metrics in parallel
        const [healthResult, activityResult, ...metricResults] = await Promise.all([
          getResourceHealth(subscription, resourceId),
          getActivityLogs(subscription, timeframeHours, resourceId),
          ...metricPromises.map((m) => m.promise),
        ]);

        // Process health
        if (healthResult.error) {
          errors.push(healthResult.error);
        } else if (healthResult.statuses.length > 0) {
          const status = healthResult.statuses[0];
          const currentHealth = status.properties?.availabilityState ?? "Unknown";
          if (currentHealth !== "Available") {
            allEvents.push({
              time: new Date().toISOString(),
              event: `Health status: ${currentHealth}`,
              source: "ResourceHealth",
              severity: currentHealth === "Unavailable" ? "critical" : "warning",
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
              severity: status === "Failed" ? "warning" : "info",
            });
          }
        }

        // Process metrics — detect anomalies inline using simple statistics
        for (let i = 0; i < metricResults.length; i++) {
          const result = metricResults[i];
          const meta = metricPromises[i];
          if (result.error) { errors.push(result.error); continue; }
          if (!result.data) continue;

          for (const metric of result.data.metrics) {
            for (const ts of metric.timeseries) {
              if (!ts.data) continue;
              const dataPoints = ts.data
                .filter((dp) => dp.average !== undefined || dp.maximum !== undefined)
                .map((dp) => ({
                  timestamp:
                    (dp as unknown as { timeStamp: Date }).timeStamp?.toISOString() ??
                    new Date().toISOString(),
                  value: dp.average ?? dp.maximum ?? 0,
                }));

              if (dataPoints.length < 3) continue;

              // Simple anomaly detection: mean + 2 standard deviations
              const values = dataPoints.map((p) => p.value);
              const mean = values.reduce((a, b) => a + b, 0) / values.length;
              const stdDev = Math.sqrt(
                values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
              );
              const warningThreshold = mean + 2 * stdDev;
              const criticalThreshold = mean + 3 * stdDev;

              // Also flag if metric is a percentage and exceeds 90/95
              const isPercentage = /percent/i.test(metric.name) || metric.unit === "Percent";

              for (const dp of dataPoints) {
                let severity: "critical" | "warning" | null = null;

                if (isPercentage) {
                  if (dp.value >= 95) severity = "critical";
                  else if (dp.value >= 90) severity = "warning";
                } else if (stdDev > 0) {
                  if (dp.value >= criticalThreshold) severity = "critical";
                  else if (dp.value >= warningThreshold) severity = "warning";
                }

                if (severity) {
                  allEvents.push({
                    time: dp.timestamp,
                    event: `${metric.name} spike: ${Math.round(dp.value * 100) / 100} (${meta?.label ?? "unknown"})`,
                    source: "MetricAnomaly",
                    severity,
                  });
                }
              }
            }
          }
        }

        // Sort events by time and build timeline
        allEvents.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        eventCount = allEvents.length;

        timelineMermaid = renderMermaidTimeline(
          allEvents.map((e) => ({
            time: e.time,
            event: e.event,
            source: e.source,
            severity: e.severity,
          }))
        );
      }

      // ── 4. Build response ────────────────────────────────────────────
      const diagrams: Record<string, unknown> = {};
      if (topologyMermaid !== undefined) {
        diagrams.topology = {
          mermaid: topologyMermaid,
          ascii: topologyAscii,
        };
      }
      if (timelineMermaid !== undefined) {
        diagrams.timeline = {
          mermaid: timelineMermaid,
        };
      }

      const response = {
        resource: resourceName,
        resourceType,
        diagrams,
        dependencyCount,
        eventCount,
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
