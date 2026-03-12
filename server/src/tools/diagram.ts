import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
  getResourceHealth,
  getActivityLogs,
  getMetrics,
  batchExecute,
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";
import {
  correlateTimelines,
  detectMetricAnomalies,
} from "../utils/correlator.js";
import type { DiagnosticEvent } from "../utils/correlator.js";
import { getMetricConfig, getDependencyQueries } from "../utils/metric-config.js";
import {
  renderTopology,
  renderMermaidTopology,
  renderMermaidTimeline,
} from "../utils/formatters.js";
import type { TopologyNode } from "../utils/formatters.js";

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

      // 2. Build topology if requested
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

        // Discover dependencies
        const depNodes: TopologyNode[] = [];
        if (resolvedResourceGroup) {
          const depQueries = getDependencyQueries(resourceType, resolvedResourceGroup);
          if (depQueries.length > 0) {
            const depResults = await Promise.all(
              depQueries.map((dq) => queryResourceGraph([subscription], dq.query))
            );

            // Collect and deduplicate
            const allDeps = new Map<string, { id: string; name: string; type: string }>();
            for (const result of depResults) {
              for (const dep of result.resources) {
                const depId = dep.id as string;
                if (!allDeps.has(depId)) {
                  allDeps.set(depId, {
                    id: depId,
                    name: dep.name as string,
                    type: dep.type as string,
                  });
                }
              }
              if (result.error) {
                errors.push(result.error);
              }
            }

            // Check health of each dependency
            const healthChecks = await batchExecute(
              Array.from(allDeps.values()).map((dep) => async () => {
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

      // 3. Build timeline if requested
      let timelineMermaid: string | undefined;
      let eventCount = 0;

      if (diagramType === "timeline" || diagramType === "both") {
        const allEvents: DiagnosticEvent[] = [];
        const metricConfig = getMetricConfig(resourceType);

        const [healthResult, activityResult, metricsResult] = await Promise.all([
          getResourceHealth(subscription, resourceId),
          getActivityLogs(subscription, timeframeHours, resourceId),
          metricConfig
            ? getMetrics(resourceId, metricConfig.names, timeframeHours)
            : Promise.resolve({ data: null, error: undefined }),
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
              resource: resourceName,
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
              resource: resourceName,
              actor: event.caller,
              severity: status === "Failed" ? "warning" : "info",
            });
          }
        }

        // Process metrics
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

        // Correlate and build timeline
        const correlation = correlateTimelines(allEvents);
        eventCount = correlation.timeline.length;

        timelineMermaid = renderMermaidTimeline(
          correlation.timeline.map((e) => ({
            time: e.time,
            event: e.event,
            source: e.source,
            severity: e.severity,
          }))
        );
      }

      // 4. Build response
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
