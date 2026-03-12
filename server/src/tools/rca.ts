import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
  getResourceHealth,
  getActivityLogs,
  getMetrics,
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";
import { correlateTimelines, detectMetricAnomalies } from "../utils/correlator.js";
import type { DiagnosticEvent } from "../utils/correlator.js";
import { formatRCA } from "../utils/formatters.js";
import { getMetricConfig } from "../utils/metric-config.js";

export function registerRca(server: McpServer): void {
  server.tool(
    "azdoctor_rca",
    "Generate a structured Root Cause Analysis document from investigation results. Produces markdown suitable for ServiceNow, post-incident reviews, or export.",
    {
      resource: z.string().describe("Resource name or full Azure resource ID"),
      subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      incidentStart: z
        .string()
        .optional()
        .describe("ISO timestamp for incident start"),
      incidentEnd: z
        .string()
        .optional()
        .describe("ISO timestamp for incident resolution"),
      includeRecommendations: z
        .boolean()
        .default(true)
        .describe("Whether to include follow-up recommendations"),
      outputFormat: z
        .enum(["markdown", "json"])
        .default("markdown")
        .describe("Output format: markdown for human-readable RCA, json for structured data"),
    },
    async ({
      resource,
      subscription: subParam,
      incidentStart,
      incidentEnd,
      includeRecommendations,
      outputFormat,
    }) => {
      const subscription = await resolveSubscription(subParam);
      const errors: AzureError[] = [];
      const allEvents: DiagnosticEvent[] = [];

      // Determine investigation window from incident times or default to 24h
      const now = new Date();
      const end = incidentEnd ? new Date(incidentEnd) : now;
      const start = incidentStart
        ? new Date(incidentStart)
        : new Date(end.getTime() - 24 * 60 * 60 * 1000);
      const hoursBack = Math.max(
        1,
        (end.getTime() - start.getTime()) / (60 * 60 * 1000)
      );

      // 1. Resolve resource
      let resourceId = resource;
      let resourceType = "Unknown";
      let resourceName = resource;

      if (!resource.startsWith("/subscriptions/")) {
        const resolveQuery = `Resources | where name =~ '${resource}' | project id, name, type, location, resourceGroup | take 1`;
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
        const parts = resource.split("/");
        resourceName = parts[parts.length - 1] ?? resource;
        const providerIdx = parts.indexOf("providers");
        if (providerIdx !== -1 && parts.length > providerIdx + 2) {
          resourceType = `${parts[providerIdx + 1]}/${parts[providerIdx + 2]}`;
        }
      }

      // 2. Gather signals in parallel
      const metricConfig = getMetricConfig(resourceType);

      const [healthResult, activityResult, metricsResult] =
        await Promise.all([
          getResourceHealth(subscription, resourceId),
          getActivityLogs(subscription, hoursBack, resourceId),
          metricConfig
            ? getMetrics(resourceId, metricConfig.names, hoursBack)
            : Promise.resolve({ data: null, error: undefined }),
        ]);

      // Process health
      let currentHealth = "Unknown";
      if (healthResult.error) {
        errors.push(healthResult.error);
      } else if (healthResult.statuses.length > 0) {
        currentHealth =
          healthResult.statuses[0].properties?.availabilityState ?? "Unknown";
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
            "Unknown";
          allEvents.push({
            time: event.eventTimestamp?.toISOString() ?? new Date().toISOString(),
            event: `${opName} (${event.status?.value ?? "unknown"})`,
            source: "ActivityLog",
            resource: resourceName,
            actor: event.caller,
          });
        }
      }

      // Process metrics
      if (metricsResult.data && metricConfig) {
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
            allEvents.push(
              ...detectMetricAnomalies(resourceId, metric.name, dataPoints, {
                warningPct: metricConfig.warningPct,
                criticalPct: metricConfig.criticalPct,
              })
            );
          }
        }
      }

      // 3. Correlate
      const correlation = correlateTimelines(allEvents);

      // 4. Calculate incident duration
      let duration = "Unknown";
      if (incidentStart && incidentEnd) {
        const durationMs =
          new Date(incidentEnd).getTime() - new Date(incidentStart).getTime();
        const hours = Math.floor(durationMs / 3600000);
        const minutes = Math.round((durationMs % 3600000) / 60000);
        duration =
          hours > 0 ? `${hours}h ${minutes}m` : `${minutes} minutes`;
      } else if (incidentStart) {
        duration = "Ongoing";
      }

      // 5. Build affected resources list
      const affectedResources = [resourceName];
      // Add any dependent resources from correlation
      const depResources = new Set(
        correlation.timeline
          .filter((e) => e.resource && e.resource !== resourceName)
          .map((e) => e.resource!)
      );
      affectedResources.push(...depResources);

      // 6. Build recommendations
      const recommendations: string[] = [];
      if (includeRecommendations) {
        if (correlation.precedingChanges.length > 0) {
          const change = correlation.precedingChanges[correlation.precedingChanges.length - 1];
          recommendations.push(
            `Review the change at ${change.time}: "${change.event}"`
          );
          if (change.actor) {
            recommendations.push(
              `Contact ${change.actor} for context on the change.`
            );
          }
        }
        if (currentHealth !== "Available" && currentHealth !== "Unknown") {
          recommendations.push(
            "Set up Azure Monitor alerts for this resource to catch future incidents earlier."
          );
        }
        recommendations.push(
          "Consider adding deployment gates or health checks to prevent similar incidents."
        );
      }

      // 7. Format as RCA document
      const rcaInput = {
        resource: resourceName,
        resourceType,
        subscription,
        incidentStart: incidentStart ?? start.toISOString(),
        incidentEnd: incidentEnd ?? (currentHealth === "Available" ? now.toISOString() : undefined),
        timeline: correlation.timeline,
        rootCause: correlation.likelyCause,
        impact: {
          duration,
          affectedResources,
        },
        remediationApplied: incidentEnd
          ? ["Incident was resolved (end time provided)."]
          : ["Incident may still be ongoing."],
        recommendations,
      };

      if (outputFormat === "json") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            ...rcaInput,
            confidence: correlation.confidence,
            cascadingFailure: correlation.cascadingFailure,
            generatedAt: new Date().toISOString(),
          }, null, 2) }],
        };
      }

      const rca = formatRCA(rcaInput);
      return {
        content: [{ type: "text" as const, text: rca }],
      };
    }
  );
}
