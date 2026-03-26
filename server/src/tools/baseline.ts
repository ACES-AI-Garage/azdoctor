import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
  getMetrics,
  listMetricDefinitions,
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";

// Resources where key metrics live on a parent resource, not the resource itself.
// The baseline tool auto-resolves these so users don't need to know.
const PARENT_METRIC_RESOURCES: Record<string, { property: string; label: string }> = {
  "microsoft.web/sites": { property: "properties.serverFarmId", label: "App Service Plan" },
};

// Max metrics to pull per resource to avoid huge responses
const MAX_METRICS = 15;

// Priority patterns for sorting discovered metrics by relevance
const PRIORITY_PATTERNS = [/percent/i, /cpu/i, /memory/i, /error/i, /5xx/i, /4xx/i, /fail/i, /latency/i, /response.*time/i, /request/i, /connection/i, /dtu/i, /throughput/i, /availability/i, /queue/i, /count/i];

interface BaselineMetric {
  metricName: string;
  source: string;
  unit: string;
  current: number;
  baselineMean: number;
  baselineStdDev: number;
  zScore: number;
  status: "normal" | "elevated" | "anomalous";
  direction: "above" | "below" | "at";
}

function calculateMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function calculateStdDev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const sumSquaredDiffs = values.reduce(
    (sum, v) => sum + (v - mean) ** 2,
    0
  );
  return Math.sqrt(sumSquaredDiffs / (values.length - 1));
}

function sortByPriority(defs: Array<{ name: string }>): Array<{ name: string }> {
  return [...defs].sort((a, b) => {
    const aScore = PRIORITY_PATTERNS.findIndex((p) => p.test(a.name));
    const bScore = PRIORITY_PATTERNS.findIndex((p) => p.test(b.name));
    return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
  });
}

export function registerBaseline(server: McpServer): void {
  server.tool(
    "azdoctor_baseline",
    "Compare current resource metrics against their 7-day baseline using z-scores. Dynamically discovers available metrics — no hardcoded resource knowledge. Returns raw statistical data for AI analysis.",
    {
      resource: z.string().describe("Resource name or full Azure resource ID"),
      subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z.string().optional().describe("Resource group name (helps resolve resource ID faster)"),
      baselineDays: z.number().default(7).describe("Days of history to use as baseline"),
    },
    async ({ resource, subscription: subParam, resourceGroup, baselineDays }) => {
      const subscription = await resolveSubscription(subParam);
      const errors: AzureError[] = [];

      // -- 1. Resolve resource (same Resource Graph pattern as investigate) --
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

      // -- 2. Discover available metrics dynamically --
      const metricDefs = await listMetricDefinitions(resourceId);
      if (metricDefs.error) errors.push(metricDefs.error);

      const sortedDefs = sortByPriority(metricDefs.definitions);
      const selectedMetrics = sortedDefs.slice(0, MAX_METRICS).map((d) => d.name);

      // -- 3. Check if this resource type has metrics on a parent --
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
      let parentMetricDefs: Awaited<ReturnType<typeof listMetricDefinitions>> = { definitions: [] };
      if (parentResourceId) {
        parentMetricDefs = await listMetricDefinitions(parentResourceId);
        if (parentMetricDefs.error) errors.push(parentMetricDefs.error);
        const parentSorted = sortByPriority(parentMetricDefs.definitions);
        parentMetricNames = parentSorted.slice(0, MAX_METRICS).map((d) => d.name);
      }

      // -- 4. Pull metrics for CURRENT period (last 1 hour, PT5M granularity) --
      // -- 5. Pull metrics for BASELINE period (last N days, PT1H granularity) --
      interface MetricTarget {
        label: string;
        resourceId: string;
        metricNames: string[];
        defs: Array<{ name: string; unit: string }>;
      }

      const targets: MetricTarget[] = [];

      if (selectedMetrics.length > 0) {
        targets.push({
          label: resourceName,
          resourceId,
          metricNames: selectedMetrics,
          defs: metricDefs.definitions,
        });
      }

      if (parentResourceId && parentMetricNames.length > 0) {
        targets.push({
          label: parentLabel ?? "parent",
          resourceId: parentResourceId,
          metricNames: parentMetricNames,
          defs: parentMetricDefs.definitions,
        });
      }

      // Pull current and baseline in parallel for all targets
      const currentPromises = targets.map((t) =>
        getMetrics(t.resourceId, t.metricNames, 1, "PT5M")
      );
      const baselinePromises = targets.map((t) =>
        getMetrics(t.resourceId, t.metricNames, baselineDays * 24, "PT1H")
      );

      const allResults = await Promise.all([...currentPromises, ...baselinePromises]);
      const currentResults = allResults.slice(0, targets.length);
      const baselineResults = allResults.slice(targets.length);

      // -- 6. For each metric, compute z-score analysis --
      const baselineMetrics: BaselineMetric[] = [];

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const currentResult = currentResults[i];
        const baselineResult = baselineResults[i];

        if (currentResult.error) errors.push(currentResult.error);
        if (baselineResult.error) errors.push(baselineResult.error);
        if (!currentResult.data || !baselineResult.data) continue;

        // Build a map of current values by metric name
        const currentValues = new Map<string, number>();
        for (const metric of currentResult.data.metrics) {
          for (const ts of metric.timeseries) {
            if (!ts.data) continue;
            const points = ts.data
              .filter((dp) => dp.average !== undefined || dp.maximum !== undefined || dp.total !== undefined)
              .map((dp) => dp.average ?? dp.total ?? 0);
            if (points.length > 0) {
              // Use the most recent data point as the current value
              currentValues.set(metric.name, points[points.length - 1]);
            }
          }
        }

        // Build baseline stats from the 7-day data
        for (const metric of baselineResult.data.metrics) {
          for (const ts of metric.timeseries) {
            if (!ts.data) continue;
            const allValues = ts.data
              .filter((dp) => dp.average !== undefined || dp.maximum !== undefined || dp.total !== undefined)
              .map((dp) => dp.average ?? dp.total ?? 0);

            if (allValues.length < 2) continue;

            const current = currentValues.get(metric.name);
            if (current === undefined) continue;

            const mean = calculateMean(allValues);
            const stddev = calculateStdDev(allValues, mean);
            const zScore = stddev > 0 ? (current - mean) / stddev : 0;
            const absZ = Math.abs(zScore);

            let status: "normal" | "elevated" | "anomalous";
            if (absZ >= 2) {
              status = "anomalous";
            } else if (absZ >= 1) {
              status = "elevated";
            } else {
              status = "normal";
            }

            let direction: "above" | "below" | "at";
            if (zScore > 0.1) {
              direction = "above";
            } else if (zScore < -0.1) {
              direction = "below";
            } else {
              direction = "at";
            }

            const defUnit = target.defs.find((d) => d.name === metric.name)?.unit ?? metric.unit ?? "Unspecified";

            baselineMetrics.push({
              metricName: metric.name,
              source: target.label,
              unit: defUnit,
              current: Math.round(current * 100) / 100,
              baselineMean: Math.round(mean * 100) / 100,
              baselineStdDev: Math.round(stddev * 100) / 100,
              zScore: Math.round(zScore * 100) / 100,
              status,
              direction,
            });
          }
        }
      }

      // -- 7. Build response -- raw data, no opinions --
      const response: Record<string, unknown> = {
        resource: resourceName,
        resourceType,
        resourceGroup: resolvedRG,
        baselineDays,
        timestamp: new Date().toISOString(),
      };

      if (baselineMetrics.length > 0) {
        response.metrics = baselineMetrics;
      } else if (metricDefs.definitions.length === 0 && parentMetricNames.length === 0) {
        response.metrics = "This resource type does not emit Azure Monitor metrics.";
      } else {
        response.metrics = `Metrics discovered but no data returned for the analysis window.`;
      }

      // Available metrics not pulled (for context)
      const allDefCount = metricDefs.definitions.length + parentMetricDefs.definitions.length;
      const allPulledCount = selectedMetrics.length + parentMetricNames.length;
      if (allDefCount > allPulledCount) {
        response.additionalMetricsAvailable = [
          ...metricDefs.definitions.slice(MAX_METRICS).map((d) => d.name),
          ...parentMetricDefs.definitions.slice(MAX_METRICS).map((d) => d.name),
        ];
      }

      if (errors.length > 0) {
        response.apiErrors = errors.map((e) => `${e.code}: ${e.message}`);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
