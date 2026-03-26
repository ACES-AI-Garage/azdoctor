import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
  getResourceHealth,
  getActivityLogs,
  getMetrics,
  listMetricDefinitions,
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";

// Resources where key metrics live on a parent resource, not the resource itself.
const PARENT_METRIC_RESOURCES: Record<string, { property: string; label: string }> = {
  "microsoft.web/sites": { property: "properties.serverFarmId", label: "App Service Plan" },
};

// Max metrics to pull per resource to keep the response manageable
const MAX_METRICS = 15;

interface TimelineEvent {
  timestamp: string;
  type: "activity" | "metric" | "health";
  event: string;
  source: string;
  actor?: string;
  severity?: "info" | "warning" | "critical";
  metricValue?: number;
  metricUnit?: string;
  phaseMarker?: "pre-incident" | "incident-start" | "during-incident" | "resolution" | "post-incident";
}

export function registerPlayback(server: McpServer): void {
  server.tool(
    "azdoctor_playback",
    "Replay an incident timeline event-by-event in chronological order. Shows what happened, when, and provides context for each event — useful for post-incident learning and reviews.",
    {
      resource: z.string().describe("Resource name or full Azure resource ID"),
      subscription: z.string().optional(),
      startTime: z.string().describe("ISO timestamp for playback start"),
      endTime: z.string().optional().describe("ISO timestamp for playback end (defaults to now)"),
    },
    async ({ resource, subscription: subParam, startTime, endTime }) => {
      const subscription = await resolveSubscription(subParam);
      const errors: AzureError[] = [];

      // ── 1. Resolve resource (same Resource Graph pattern as investigate) ──
      let resourceId = resource;
      let resourceType = "unknown";
      let resourceName = resource;
      let resourceProperties: Record<string, unknown> = {};

      if (!resource.startsWith("/subscriptions/")) {
        const q = `Resources | where name =~ '${resource}' | project id, name, type, location, resourceGroup, properties | take 1`;
        const result = await queryResourceGraph([subscription], q);
        if (result.resources.length > 0) {
          const r = result.resources[0];
          resourceId = r.id as string;
          resourceType = (r.type as string) ?? "unknown";
          resourceName = (r.name as string) ?? resource;
          resourceProperties = (r.properties as Record<string, unknown>) ?? {};
        } else if (result.error) {
          errors.push(result.error);
        }
      } else {
        const parts = resource.split("/");
        resourceName = parts[parts.length - 1] ?? resource;
        const pi = parts.indexOf("providers");
        if (pi !== -1 && parts.length > pi + 2) resourceType = `${parts[pi + 1]}/${parts[pi + 2]}`;
      }

      // ── 2. Calculate time window ──────────────────────────────────────────
      const startDate = new Date(startTime);
      const endDate = endTime ? new Date(endTime) : new Date();
      const hoursBack = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (60 * 60 * 1000)));

      // ── 3. Discover available metrics dynamically ─────────────────────────
      const metricDefs = await listMetricDefinitions(resourceId);
      if (metricDefs.error) errors.push(metricDefs.error);

      const priorityPatterns = [/percent/i, /cpu/i, /memory/i, /error/i, /5xx/i, /4xx/i, /fail/i, /latency/i, /response.*time/i, /request/i, /connection/i, /dtu/i, /throughput/i, /availability/i, /queue/i, /count/i];
      const sortedDefs = [...metricDefs.definitions].sort((a, b) => {
        const aScore = priorityPatterns.findIndex((p) => p.test(a.name));
        const bScore = priorityPatterns.findIndex((p) => p.test(b.name));
        return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
      });
      const selectedMetrics = sortedDefs.slice(0, MAX_METRICS).map((d) => d.name);

      // ── 4. For App Services, resolve parent (App Service Plan) for CPU/Memory ─
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

      // ── 5. Gather all signals in parallel ─────────────────────────────────
      interface MetricFetch { label: string; resourceId: string; promise: ReturnType<typeof getMetrics> }
      const metricPromises: MetricFetch[] = [];

      if (selectedMetrics.length > 0) {
        metricPromises.push({
          label: resourceName,
          resourceId,
          promise: getMetrics(resourceId, selectedMetrics, hoursBack, "PT5M"),
        });
      }

      if (parentResourceId && parentMetricNames.length > 0) {
        metricPromises.push({
          label: parentLabel ?? "parent",
          resourceId: parentResourceId,
          promise: getMetrics(parentResourceId, parentMetricNames, hoursBack, "PT5M"),
        });
      }

      const [healthResult, activityResult, ...metricResults] = await Promise.all([
        getResourceHealth(subscription, resourceId),
        getActivityLogs(subscription, hoursBack, resourceId),
        ...metricPromises.map((m) => m.promise),
      ]);

      // ── 6. Build raw timeline events ──────────────────────────────────────
      const allEvents: TimelineEvent[] = [];

      // Health events
      if (healthResult.error) {
        errors.push(healthResult.error);
      } else if (healthResult.statuses.length > 0) {
        const status = healthResult.statuses[0];
        const availState = status.properties?.availabilityState ?? "Unknown";
        if (availState !== "Available") {
          allEvents.push({
            timestamp: new Date().toISOString(),
            type: "health",
            event: `Health status: ${availState} — ${status.properties?.summary ?? ""}`,
            source: "ResourceHealth",
            severity: availState === "Unavailable" ? "critical" : "warning",
          });
        }
      }

      // Activity log events
      if (activityResult.error) {
        errors.push(activityResult.error);
      } else {
        for (const event of activityResult.events) {
          const opName =
            event.operationName?.localizedValue ??
            event.operationName?.value ??
            "Unknown operation";
          const status = event.status?.value ?? "";
          const op = event.operationName?.value ?? "";
          const timestamp = event.eventTimestamp?.toISOString() ?? new Date().toISOString();

          // Include notable events: config changes, deployments, restarts, failures
          const isNotable =
            status === "Failed" ||
            op.includes("write") ||
            op.includes("deploy") ||
            op.includes("restart") ||
            op.includes("delete") ||
            op.includes("action") ||
            op.includes("start") ||
            op.includes("stop");

          if (isNotable) {
            allEvents.push({
              timestamp,
              type: "activity",
              event: `${opName} (${status})`,
              source: "ActivityLog",
              actor: event.caller,
              severity: status === "Failed" ? "warning" : "info",
            });
          }
        }
      }

      // Metric data points
      for (let i = 0; i < metricResults.length; i++) {
        const result = metricResults[i];
        const meta = metricPromises[i];
        if (result.error) { errors.push(result.error); continue; }
        if (!result.data) continue;

        for (const metric of result.data.metrics) {
          const defUnit = metricDefs.definitions.find((d) => d.name === metric.name)?.unit ?? metric.unit ?? "Unspecified";

          for (const ts of metric.timeseries) {
            if (!ts.data) continue;
            for (const dp of ts.data) {
              const value = dp.average ?? dp.maximum ?? dp.total;
              if (value === undefined) continue;
              const pointTime =
                (dp as unknown as { timeStamp: Date }).timeStamp?.toISOString() ??
                new Date().toISOString();

              allEvents.push({
                timestamp: pointTime,
                type: "metric",
                event: `${metric.name}: ${Math.round(value * 100) / 100} ${defUnit}`,
                source: `Metrics (${meta?.label ?? "unknown"})`,
                metricValue: Math.round(value * 100) / 100,
                metricUnit: defUnit,
              });
            }
          }
        }
      }

      // ── 7. Filter to playback window and sort chronologically ─────────────
      const windowEvents = allEvents.filter((e) => {
        const t = new Date(e.timestamp).getTime();
        return t >= startDate.getTime() && t <= endDate.getTime();
      });

      windowEvents.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // ── 8. Assign phase markers based on the data ─────────────────────────
      // Identify anomaly events: health issues, failed operations, elevated metrics
      const anomalyEvents = windowEvents.filter(
        (e) =>
          e.type === "health" ||
          (e.type === "activity" && e.severity === "warning") ||
          e.severity === "critical"
      );

      const firstAnomalyTime = anomalyEvents.length > 0
        ? new Date(anomalyEvents[0].timestamp).getTime()
        : null;
      const lastAnomalyTime = anomalyEvents.length > 0
        ? new Date(anomalyEvents[anomalyEvents.length - 1].timestamp).getTime()
        : null;

      // Resolution: first activity event after the last anomaly
      let resolutionTime: number | null = null;
      if (lastAnomalyTime !== null) {
        const postAnomalyChanges = windowEvents.filter((e) => {
          const t = new Date(e.timestamp).getTime();
          return t > lastAnomalyTime && e.type === "activity" && e.severity !== "warning";
        });
        if (postAnomalyChanges.length > 0) {
          resolutionTime = new Date(postAnomalyChanges[0].timestamp).getTime();
        }
      }

      for (const e of windowEvents) {
        const t = new Date(e.timestamp).getTime();

        if (firstAnomalyTime === null) {
          e.phaseMarker = "pre-incident";
        } else if (t < firstAnomalyTime) {
          e.phaseMarker = "pre-incident";
        } else if (t === firstAnomalyTime && e === anomalyEvents[0]) {
          e.phaseMarker = "incident-start";
        } else if (lastAnomalyTime !== null && t <= lastAnomalyTime) {
          e.phaseMarker = "during-incident";
        } else if (resolutionTime !== null && t <= resolutionTime && e.type === "activity") {
          e.phaseMarker = "resolution";
        } else if (lastAnomalyTime !== null && t > lastAnomalyTime) {
          e.phaseMarker = "post-incident";
        } else {
          e.phaseMarker = "during-incident";
        }
      }

      // ── 9. Build response ─────────────────────────────────────────────────
      const durationMs = endDate.getTime() - startDate.getTime();
      const durationHours = Math.floor(durationMs / (60 * 60 * 1000));
      const durationMinutes = Math.floor((durationMs % (60 * 60 * 1000)) / (60 * 1000));
      const durationStr = durationHours > 0
        ? `${durationHours}h ${durationMinutes}m`
        : `${durationMinutes}m`;

      const preIncidentCount = windowEvents.filter((e) => e.phaseMarker === "pre-incident").length;
      const duringIncidentCount = windowEvents.filter((e) => e.phaseMarker === "during-incident").length;
      const postIncidentCount = windowEvents.filter((e) => e.phaseMarker === "post-incident").length;

      const incidentStartTimestamp = firstAnomalyTime
        ? new Date(firstAnomalyTime).toISOString()
        : null;
      const resolutionTimestamp = resolutionTime
        ? new Date(resolutionTime).toISOString()
        : null;

      const response = {
        resource: resourceName,
        resourceType,
        playbackWindow: `${startDate.toISOString()} to ${endDate.toISOString()}`,
        duration: durationStr,
        totalEvents: windowEvents.length,
        metricsDiscovered: selectedMetrics.length + parentMetricNames.length,
        parentResource: parentResourceId ? { id: parentResourceId, label: parentLabel } : undefined,
        phases: {
          preIncident: preIncidentCount,
          incidentStart: incidentStartTimestamp,
          duringIncident: duringIncidentCount,
          resolution: resolutionTimestamp,
          postIncident: postIncidentCount,
        },
        timeline: windowEvents,
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
