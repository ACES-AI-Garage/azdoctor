import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
  listMetricDefinitions,
} from "../utils/azure-client.js";
import type { AzureError, MetricDefinition } from "../utils/azure-client.js";

// Resources where key metrics live on a parent resource, not the resource itself.
const PARENT_METRIC_RESOURCES: Record<string, { property: string; label: string }> = {
  "microsoft.web/sites": { property: "properties.serverFarmId", label: "App Service Plan" },
};

// Patterns that indicate a metric is important for alerting, ordered by priority.
const ALERTABLE_PATTERNS: Array<{ pattern: RegExp; defaultOperator: "GreaterThan" | "LessThan"; category: string }> = [
  { pattern: /error|5xx|4xx|fail/i, defaultOperator: "GreaterThan", category: "errors" },
  { pattern: /cpu/i, defaultOperator: "GreaterThan", category: "cpu" },
  { pattern: /memory/i, defaultOperator: "GreaterThan", category: "memory" },
  { pattern: /response.*time|latency|duration/i, defaultOperator: "GreaterThan", category: "latency" },
  { pattern: /availab/i, defaultOperator: "LessThan", category: "availability" },
  { pattern: /queue.*length|queue.*depth/i, defaultOperator: "GreaterThan", category: "queue" },
  { pattern: /dtu/i, defaultOperator: "GreaterThan", category: "dtu" },
  { pattern: /connection.*fail|connection.*error/i, defaultOperator: "GreaterThan", category: "connection" },
  { pattern: /deadlock/i, defaultOperator: "GreaterThan", category: "deadlock" },
  { pattern: /storage.*percent/i, defaultOperator: "GreaterThan", category: "storage" },
  { pattern: /server.*load/i, defaultOperator: "GreaterThan", category: "load" },
  { pattern: /percent|ratio/i, defaultOperator: "GreaterThan", category: "percentage" },
  { pattern: /throttl/i, defaultOperator: "GreaterThan", category: "throttle" },
  { pattern: /request/i, defaultOperator: "GreaterThan", category: "requests" },
  { pattern: /count|total/i, defaultOperator: "GreaterThan", category: "count" },
];

// Max alert rules to generate per resource
const MAX_ALERTS_PER_RESOURCE = 10;

interface AlertRecommendation {
  name: string;
  metricName: string;
  metricSource: string; // resource ID the metric comes from
  sourceLabel: string;  // human-readable label (e.g., "App Service Plan")
  operator: "GreaterThan" | "LessThan" | "GreaterOrLessThan";
  threshold: number;
  windowSize: string;
  frequency: string;
  severity: 0 | 1 | 2 | 3 | 4;
  reason: string;
  unit: string;
}

/**
 * Pick a sensible default threshold based on the metric's unit and category.
 */
function pickDefaultThreshold(
  def: MetricDefinition,
  category: string,
  operator: "GreaterThan" | "LessThan"
): number {
  const unit = def.unit.toLowerCase();
  const name = def.name.toLowerCase();

  // Percentage metrics — alert at 85% (or below 99% for availability)
  if (unit === "percent" || name.includes("percent") || name.includes("ratio")) {
    if (operator === "LessThan") return 99; // availability
    return 85;
  }

  // Error/failure count metrics — alert on any notable count
  if (category === "errors" || category === "deadlock" || category === "connection") {
    return category === "deadlock" ? 1 : 10;
  }

  // Latency metrics (usually seconds or milliseconds)
  if (category === "latency") {
    if (unit === "milliseconds") return 5000;
    return 5; // seconds
  }

  // Queue length/depth
  if (category === "queue") return 10;

  // Throttle count
  if (category === "throttle") return 5;

  // Byte-based metrics (e.g., available memory)
  if (unit === "bytes" && operator === "LessThan") return 1073741824; // 1 GB

  // Generic count
  return 100;
}

/**
 * Pick severity: errors/availability get Sev 1, capacity/latency get Sev 2, rest Sev 3.
 */
function pickSeverity(category: string): 0 | 1 | 2 | 3 | 4 {
  switch (category) {
    case "errors":
    case "availability":
    case "connection":
    case "deadlock":
      return 1;
    case "cpu":
    case "memory":
    case "latency":
    case "dtu":
    case "load":
    case "storage":
      return 2;
    default:
      return 3;
  }
}

/**
 * Pick window/frequency based on category.
 */
function pickWindow(category: string): { windowSize: string; frequency: string } {
  if (category === "storage") {
    return { windowSize: "PT15M", frequency: "PT5M" };
  }
  return { windowSize: "PT5M", frequency: "PT1M" };
}

/**
 * Build a human-readable name from the metric name.
 * "CpuPercentage" → "Cpu Percentage", "Http5xx" → "Http5xx"
 */
function humanize(metricName: string): string {
  return metricName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Match a metric definition to an alertable pattern.
 */
function matchMetric(def: MetricDefinition): { category: string; operator: "GreaterThan" | "LessThan" } | null {
  for (const entry of ALERTABLE_PATTERNS) {
    if (entry.pattern.test(def.name)) {
      let operator = entry.defaultOperator;
      // Override: if unit is "percent" and name contains "avail", use LessThan
      if (/availab/i.test(def.name)) operator = "LessThan";
      // Override: if name contains "available" + bytes (e.g., Available Memory Bytes), use LessThan
      if (/available/i.test(def.name) && def.unit.toLowerCase() === "bytes") operator = "LessThan";
      return { category: entry.category, operator };
    }
  }
  return null;
}

/**
 * Build alert recommendations from discovered metric definitions.
 */
function buildRecommendations(
  definitions: MetricDefinition[],
  resourceId: string,
  sourceLabel: string,
): AlertRecommendation[] {
  const recommendations: AlertRecommendation[] = [];
  const seenCategories = new Set<string>();

  for (const def of definitions) {
    if (recommendations.length >= MAX_ALERTS_PER_RESOURCE) break;

    const match = matchMetric(def);
    if (!match) continue;

    // Deduplicate within a category — keep first (highest-priority) match
    const catKey = `${match.category}:${sourceLabel}`;
    if (seenCategories.has(catKey)) continue;
    seenCategories.add(catKey);

    const threshold = pickDefaultThreshold(def, match.category, match.operator);
    const severity = pickSeverity(match.category);
    const { windowSize, frequency } = pickWindow(match.category);

    const direction = match.operator === "GreaterThan" ? "exceeds" : "drops below";
    const thresholdLabel = def.unit.toLowerCase() === "percent"
      ? `${threshold}%`
      : `${threshold} ${def.unit}`;

    recommendations.push({
      name: `${humanize(def.name)} Alert`,
      metricName: def.name,
      metricSource: resourceId,
      sourceLabel,
      operator: match.operator,
      threshold,
      windowSize,
      frequency,
      severity,
      unit: def.unit,
      reason: `Alerts when ${humanize(def.name)} ${direction} ${thresholdLabel} over ${windowSize.replace("PT", "").replace("M", " minutes").replace("H", " hours")}`,
    });
  }

  return recommendations;
}

/**
 * Tailor thresholds using data from a prior investigate call.
 */
function tailorFromInvestigation(
  recommendations: AlertRecommendation[],
  contextJson: string,
): { recommendations: AlertRecommendation[]; tailored: boolean } {
  let tailored = false;

  try {
    const context = JSON.parse(contextJson);
    const result = recommendations.map((r) => ({ ...r }));

    // Extract metric summaries from investigation context
    const metrics: Array<{ name: string; avg: number; max: number; unit: string }> =
      Array.isArray(context.metrics) ? context.metrics : [];

    if (metrics.length > 0) {
      for (const rec of result) {
        const observed = metrics.find((m) => m.name === rec.metricName);
        if (!observed) continue;

        tailored = true;

        if (rec.operator === "GreaterThan") {
          // Set threshold at ~3.5x the observed average, but at least 20% above max,
          // and never below the default.
          const fromAvg = Math.round(observed.avg * 3.5);
          const fromMax = Math.round(observed.max * 1.2);
          const candidate = Math.max(fromAvg, fromMax);

          // For percentage metrics, cap at 95
          const isPercent = rec.unit.toLowerCase() === "percent" ||
            rec.metricName.toLowerCase().includes("percent");
          if (isPercent) {
            // Use the lower of candidate or 95, but ensure it's meaningfully above avg
            const adjusted = Math.min(candidate, 95);
            const minThreshold = Math.round(observed.avg + (100 - observed.avg) * 0.5);
            rec.threshold = Math.max(Math.min(adjusted, 95), Math.min(minThreshold, 95));
          } else {
            rec.threshold = Math.max(candidate, rec.threshold);
          }

          rec.reason += ` [Tailored: observed avg=${observed.avg}, max=${observed.max}]`;
        } else if (rec.operator === "LessThan") {
          // For availability/LessThan: if observed avg is 100, keep strict (99.9).
          // If observed is lower, set threshold slightly below observed.
          if (observed.avg >= 99.9) {
            rec.threshold = 99;
          } else {
            rec.threshold = Math.round(observed.avg * 0.95 * 10) / 10;
          }
          rec.reason += ` [Tailored: observed avg=${observed.avg}]`;
        }
      }
    }

    // If cascadingFailure is detected, escalate severity
    if (context.cascadingFailure === true) {
      tailored = true;
      for (const rec of result) {
        if (rec.severity > 1) {
          rec.severity = (rec.severity - 1) as 0 | 1 | 2 | 3 | 4;
        }
        rec.reason += " [Severity escalated: cascading failure detected]";
      }
    }

    return { recommendations: result, tailored };
  } catch {
    return { recommendations, tailored: false };
  }
}

function sanitizeBicepName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function generateBicep(recommendations: AlertRecommendation[]): string {
  // Group by unique resource IDs
  const resourceIds = [...new Set(recommendations.map((r) => r.metricSource))];

  const lines: string[] = [
    "// Auto-generated by AZ Doctor — based on dynamically discovered metrics",
    "// Deploy: az deployment group create -g {resourceGroup} -f alerts.bicep",
    "",
  ];

  // Generate params for each unique resource ID
  resourceIds.forEach((rid, idx) => {
    const paramName = idx === 0 ? "resourceId" : `resourceId_${idx}`;
    lines.push(`param ${paramName} string = '${rid}'`);
  });

  lines.push("param actionGroupId string = '' // Set to your Action Group resource ID");
  lines.push("");

  // Map resource IDs to param names
  const ridToParam = new Map<string, string>();
  resourceIds.forEach((rid, idx) => {
    ridToParam.set(rid, idx === 0 ? "resourceId" : `resourceId_${idx}`);
  });

  for (const rec of recommendations) {
    const sanitized = sanitizeBicepName(rec.name);
    const paramName = ridToParam.get(rec.metricSource) ?? "resourceId";

    // Pick the best aggregation — Average for percentage/latency, Total for counts
    const unitLower = rec.unit.toLowerCase();
    const aggregation = (unitLower === "count" || rec.metricName.toLowerCase().includes("count"))
      ? "Total"
      : "Average";

    lines.push(
      `resource alert_${sanitized} 'Microsoft.Insights/metricAlerts@2018-03-01' = {`,
      `  name: 'azdoctor-${rec.name.replace(/'/g, "")}'`,
      `  location: 'global'`,
      `  properties: {`,
      `    description: '${rec.reason.replace(/'/g, "\\'")}'`,
      `    severity: ${rec.severity}`,
      `    enabled: true`,
      `    scopes: [${paramName}]`,
      `    evaluationFrequency: '${rec.frequency}'`,
      `    windowSize: '${rec.windowSize}'`,
      `    criteria: {`,
      `      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'`,
      `      allOf: [`,
      `        {`,
      `          name: '${rec.metricName}'`,
      `          metricName: '${rec.metricName}'`,
      `          operator: '${rec.operator}'`,
      `          threshold: ${rec.threshold}`,
      `          timeAggregation: '${aggregation}'`,
      `          criterionType: 'StaticThresholdCriterion'`,
      `        }`,
      `      ]`,
      `    }`,
      `    actions: actionGroupId != '' ? [{ actionGroupId: actionGroupId }] : []`,
      `  }`,
      `}`,
      ""
    );
  }

  return lines.join("\n");
}

export function registerAlertRules(server: McpServer): void {
  server.tool(
    "azdoctor_alert_rules",
    "Generate Azure Monitor alert rule recommendations by dynamically discovering what metrics a resource actually emits. Outputs deployable Bicep templates with real metric names.",
    {
      resource: z.string().describe("Resource name or full Azure resource ID"),
      subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z.string().optional().describe("Resource group name (helps resolve resource ID faster)"),
      outputFormat: z
        .enum(["recommendations", "bicep"])
        .default("recommendations")
        .describe("Output as recommendations list or as deployable Bicep template"),
      investigationContext: z
        .string()
        .optional()
        .describe("JSON output from a prior azdoctor_investigate call — used to tailor alert thresholds to actual observed metric values"),
    },
    async ({ resource, subscription: subParam, resourceGroup, outputFormat, investigationContext }) => {
      const subscription = await resolveSubscription(subParam);
      const errors: AzureError[] = [];

      // ── 1. Resolve the resource ───────────────────────────────────────
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
        } else {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: `Could not find resource '${resource}' in subscription ${subscription}.`,
                suggestion: "Provide the full resource ID or specify the resourceGroup parameter.",
              }, null, 2),
            }],
          };
        }
      } else {
        const parts = resource.split("/");
        resourceName = parts[parts.length - 1] ?? resource;
        const pi = parts.indexOf("providers");
        if (pi !== -1 && parts.length > pi + 2) resourceType = `${parts[pi + 1]}/${parts[pi + 2]}`;
        const ri = parts.indexOf("resourceGroups");
        if (ri !== -1 && parts.length > ri + 1) resolvedRG = parts[ri + 1];
      }

      // ── 2. Discover available metrics dynamically ─────────────────────
      const metricDefs = await listMetricDefinitions(resourceId);
      if (metricDefs.error) errors.push(metricDefs.error);

      // Sort definitions so alertable metrics come first (by pattern priority)
      const sortedDefs = [...metricDefs.definitions].sort((a, b) => {
        const aIdx = ALERTABLE_PATTERNS.findIndex((p) => p.pattern.test(a.name));
        const bIdx = ALERTABLE_PATTERNS.findIndex((p) => p.pattern.test(b.name));
        return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
      });

      // Build alert recommendations from discovered metrics
      let recommendations = buildRecommendations(sortedDefs, resourceId, resourceName);

      // ── 3. For App Services, also resolve the parent (App Service Plan) ─
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
          if (parentResult.error) errors.push(parentResult.error);
        }
      }

      if (parentResourceId) {
        const parentDefs = await listMetricDefinitions(parentResourceId);
        if (parentDefs.error) errors.push(parentDefs.error);

        const parentSorted = [...parentDefs.definitions].sort((a, b) => {
          const aIdx = ALERTABLE_PATTERNS.findIndex((p) => p.pattern.test(a.name));
          const bIdx = ALERTABLE_PATTERNS.findIndex((p) => p.pattern.test(b.name));
          return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
        });

        const parentRecs = buildRecommendations(
          parentSorted,
          parentResourceId,
          parentLabel ?? "Parent Resource",
        );
        recommendations = [...recommendations, ...parentRecs];
      }

      // ── 4. Tailor thresholds from investigation context ───────────────
      let tailoredFromInvestigation = false;

      if (investigationContext) {
        const result = tailorFromInvestigation(recommendations, investigationContext);
        recommendations = result.recommendations;
        tailoredFromInvestigation = result.tailored;
      }

      // ── 5. Generate output ────────────────────────────────────────────
      if (recommendations.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              resource: resourceName,
              resourceType,
              metricsDiscovered: metricDefs.definitions.length,
              allMetrics: metricDefs.definitions.map((d) => d.name),
              recommendations: [],
              message: "No metrics matched alerting patterns. The available metrics are listed above — you can craft custom alerts from them.",
              apiErrors: errors.length > 0 ? errors.map((e) => `${e.code}: ${e.message}`) : undefined,
            }, null, 2),
          }],
        };
      }

      const rg = resolvedRG ?? "{resourceGroup}";
      const deployCommand = `az deployment group create -g ${rg} -f alerts.bicep`;

      if (outputFormat === "bicep") {
        const bicep = generateBicep(recommendations);
        return {
          content: [{ type: "text" as const, text: bicep }],
        };
      }

      // Default: recommendations mode
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            resource: resourceName,
            resourceType,
            metricsDiscovered: metricDefs.definitions.length,
            recommendations: recommendations.map((r) => ({
              name: r.name,
              metricName: r.metricName,
              source: r.sourceLabel,
              operator: r.operator,
              threshold: r.threshold,
              unit: r.unit,
              windowSize: r.windowSize,
              frequency: r.frequency,
              severity: r.severity,
              reason: r.reason,
            })),
            tailoredFromInvestigation,
            totalAlerts: recommendations.length,
            deployCommand,
            apiErrors: errors.length > 0 ? errors.map((e) => `${e.code}: ${e.message}`) : undefined,
          }, null, 2),
        }],
      };
    },
  );
}
