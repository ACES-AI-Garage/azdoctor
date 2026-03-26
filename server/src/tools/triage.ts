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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Parent Resource Resolution ─────────────────────────────────────
// Resources where key metrics live on a parent resource, not the resource itself.
const PARENT_METRIC_RESOURCES: Record<string, { property: string; label: string }> = {
  "microsoft.web/sites": { property: "properties.serverFarmId", label: "App Service Plan" },
};

// Max metrics to pull per resource to avoid huge responses
const MAX_METRICS = 15;

// ─── Inline Types ───────────────────────────────────────────────────

interface BaselineMetric {
  metric: string;
  current: number;
  mean: number;
  stdDev: number;
  zScore: number;
  status: "normal" | "elevated" | "anomalous";
}

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

interface AlertRecommendation {
  name: string;
  metric: string;
  suggestedThreshold: number;
  unit: string;
  reason: string;
}

interface LogData {
  workspace: string;
  failedRequests: Array<{ operation: string; statusCode: string; count: number; avgDurationMs: number }>;
  exceptions: Array<{ type: string; message: string; count: number }>;
  dependencyFailures: Array<{ target: string; type: string; resultCode: string; count: number; avgDurationMs: number }>;
}

// ─── Helpers ────────────────────────────────────────────────────────

const JOURNAL_DIR = join(homedir(), ".azdoctor", "journal");

function ensureJournalDir(): void {
  mkdirSync(JOURNAL_DIR, { recursive: true });
}

function formatDateForFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sanitizeResourceName(resource: string): string {
  return resource
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function computeBaseline(
  dataPoints: Array<{ timestamp: string; average?: number; maximum?: number }>,
  metricName: string
): BaselineMetric | null {
  const values: number[] = [];
  for (const dp of dataPoints) {
    const v = dp.average ?? dp.maximum;
    if (v !== undefined) values.push(v);
  }
  if (values.length < 2) return null;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const current = values[values.length - 1];
  const zScore = stdDev !== 0 ? (current - mean) / stdDev : 0;

  let status: BaselineMetric["status"];
  if (Math.abs(zScore) < 1) {
    status = "normal";
  } else if (Math.abs(zScore) < 2) {
    status = "elevated";
  } else {
    status = "anomalous";
  }

  return {
    metric: metricName,
    current: Math.round(current * 100) / 100,
    mean: Math.round(mean * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    zScore: Math.round(zScore * 100) / 100,
    status,
  };
}

// Priority patterns for sorting discovered metrics by relevance
const PRIORITY_PATTERNS = [
  /percent/i, /cpu/i, /memory/i, /error/i, /5xx/i, /4xx/i, /fail/i,
  /latency/i, /response.*time/i, /request/i, /connection/i, /dtu/i,
  /throughput/i, /availability/i, /queue/i, /count/i,
];

function sortAndSelectMetrics(
  definitions: Array<{ name: string; unit: string }>,
  max: number
): { selected: string[]; all: Array<{ name: string; unit: string }> } {
  const sorted = [...definitions].sort((a, b) => {
    const aScore = PRIORITY_PATTERNS.findIndex((p) => p.test(a.name));
    const bScore = PRIORITY_PATTERNS.findIndex((p) => p.test(b.name));
    return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
  });
  return {
    selected: sorted.slice(0, max).map((d) => d.name),
    all: sorted,
  };
}

function generateAlertRecommendations(
  definitions: Array<{ name: string; unit: string }>,
  metricSummaries: MetricSummary[]
): AlertRecommendation[] {
  const alerts: AlertRecommendation[] = [];

  // Pattern-based thresholds for discovered metrics
  const thresholdRules: Array<{ pattern: RegExp; threshold: number; reason: string }> = [
    { pattern: /percent|percentage/i, threshold: 85, reason: "Percentage metric approaching saturation" },
    { pattern: /cpu/i, threshold: 85, reason: "High CPU can cause request queuing and timeouts" },
    { pattern: /memory/i, threshold: 85, reason: "High memory can lead to OOM crashes" },
    { pattern: /5xx|error/i, threshold: 10, reason: "Server errors indicate application or infrastructure problems" },
    { pattern: /4xx/i, threshold: 50, reason: "High client error rate may indicate misconfiguration or attack" },
    { pattern: /latency|response.*time/i, threshold: 5000, reason: "Slow responses degrade user experience" },
    { pattern: /fail/i, threshold: 5, reason: "Failures indicate connectivity or reliability issues" },
    { pattern: /deadlock/i, threshold: 1, reason: "Any deadlock should be investigated immediately" },
    { pattern: /queue.*depth|queue.*length/i, threshold: 10, reason: "Growing queues indicate a bottleneck" },
    { pattern: /dtu/i, threshold: 90, reason: "DTU saturation causes query throttling" },
    { pattern: /server.*load/i, threshold: 80, reason: "High server load degrades all operations" },
  ];

  for (const def of definitions) {
    for (const rule of thresholdRules) {
      if (rule.pattern.test(def.name)) {
        // If we have actual metric data, refine the threshold
        const summary = metricSummaries.find((m) => m.name === def.name);
        let suggestedThreshold = rule.threshold;

        // For percentage metrics, keep the default. For count metrics, base on observed max.
        if (summary && !/percent|percentage/i.test(def.name)) {
          const observedMax = summary.max;
          if (observedMax > 0 && observedMax > suggestedThreshold) {
            // Set threshold at 2x observed max or default, whichever is higher
            suggestedThreshold = Math.max(rule.threshold, Math.round(observedMax * 2));
          }
        }

        alerts.push({
          name: def.name,
          metric: def.name,
          suggestedThreshold,
          unit: def.unit,
          reason: rule.reason,
        });
        break; // Only one alert per metric
      }
    }
  }

  return alerts;
}

function buildJournalMarkdown(report: {
  resource: string;
  resourceType: string;
  resourceGroup: string | undefined;
  timestamp: string;
  triageDuration: string;
  currentHealth: string;
  healthDetails?: Record<string, unknown>;
  symptom?: string;
  permissions: { resourceGraph: boolean; resourceHealth: boolean; activityLog: boolean; metrics: boolean; logAnalytics: boolean; summary: string };
  metrics: MetricSummary[] | string;
  recentChanges: Array<Record<string, unknown>> | string;
  logAnalytics: LogData | { workspace: string; summary: string } | null;
  dependencies: Array<{ name: string; type: string; health: string; relationship: string }>;
  baseline: { overallStatus: string; metrics: BaselineMetric[]; lookbackDays: number };
  alertRecommendations: AlertRecommendation[];
  errors: AzureError[];
}): string {
  const baselineRows =
    report.baseline.metrics.length > 0
      ? "| Metric | Current | Mean | StdDev | Z-Score | Status |\n|--------|---------|------|--------|---------|--------|\n" +
        report.baseline.metrics
          .map((m) => `| ${m.metric} | ${m.current} | ${m.mean} | ${m.stdDev} | ${m.zScore} | ${m.status} |`)
          .join("\n")
      : "No baseline metrics available.";

  const alertsBullets =
    report.alertRecommendations.length > 0
      ? report.alertRecommendations
          .map((a) => `- **${a.name}**: ${a.reason} (threshold: ${a.suggestedThreshold} ${a.unit})`)
          .join("\n")
      : "- No alert recommendations discovered for available metrics.";

  const metricSection = Array.isArray(report.metrics)
    ? report.metrics.map((m) => `- **${m.name}** (${m.source}): current=${m.current}, avg=${m.avg}, max=${m.max} ${m.unit}`).join("\n")
    : String(report.metrics);

  const changesSection = Array.isArray(report.recentChanges)
    ? report.recentChanges.map((c) => `- ${c.time}: ${c.operation} (${c.status}) by ${c.caller ?? "unknown"}`).join("\n")
    : String(report.recentChanges);

  const depsSection = report.dependencies.length > 0
    ? report.dependencies.map((d) => `- **${d.name}** (${d.type}): ${d.health} [${d.relationship}]`).join("\n")
    : "No dependencies discovered.";

  const errorsSection = report.errors.length > 0
    ? report.errors.map((e) => `- ${e.code}: ${e.message}`).join("\n")
    : "No API errors.";

  return `# Triage Report: ${report.resource}
**Date:** ${report.timestamp}
**Type:** ${report.resourceType}
**Resource Group:** ${report.resourceGroup ?? "unknown"}
**Health:** ${report.currentHealth}
**Duration:** ${report.triageDuration}
${report.symptom ? `**Reported Symptom:** ${report.symptom}` : ""}

## Permissions
${report.permissions.summary}

## Metrics
${metricSection}

## Recent Changes
${changesSection}

## Log Analytics
${report.logAnalytics ? JSON.stringify(report.logAnalytics, null, 2) : "No Log Analytics workspace found."}

## Dependencies
${depsSection}

## Baseline Comparison (${report.baseline.lookbackDays}-day)
**Overall:** ${report.baseline.overallStatus}

${baselineRows}

## Recommended Alerts
${alertsBullets}

## API Errors
${errorsSection}

---
*Auto-saved by AZ Doctor triage*
`;
}

// ─── Tool Registration ──────────────────────────────────────────────

export function registerTriage(server: McpServer): void {
  server.tool(
    "azdoctor_triage",
    "Run the full diagnostic pipeline on a resource in one command. Chains: permission check → dynamic investigation → baseline comparison → alert recommendations → journal save. Returns ALL raw data — no hardcoded analysis or correlator. Uses dynamic metric discovery via listMetricDefinitions.",
    {
      resource: z.string().describe("Resource name or full Azure resource ID"),
      subscription: z.string().optional().describe("Azure subscription ID (auto-detected if omitted)"),
      resourceGroup: z.string().optional().describe("Resource group name"),
      symptom: z.string().optional().describe("User-described symptom"),
      timeframeHours: z.number().default(24).describe("Investigation lookback window in hours"),
      baselineDays: z.number().default(7).describe("Baseline comparison lookback in days"),
      saveToJournal: z.boolean().default(true).describe("Auto-save the triage report to the incident journal"),
      generateAlerts: z.boolean().default(true).describe("Generate alert rule recommendations"),
    },
    async ({
      resource,
      subscription: subParam,
      resourceGroup,
      symptom,
      timeframeHours,
      baselineDays,
      saveToJournal,
      generateAlerts,
    }) => {
      const startTime = Date.now();
      const errors: AzureError[] = [];

      // ── Phase 1: Resolve Resource & Check Permissions ─────────────

      const subscription = await resolveSubscription(subParam);

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

      // Permissions check — probe Resource Graph, Resource Health, Activity Log
      const permissionsCheck = {
        resourceGraph: true, // Already succeeded if we got here
        resourceHealth: false,
        activityLog: false,
        metrics: false,
        logAnalytics: false,
        summary: "",
      };

      // ── Phase 2: Dynamic Metric Discovery ─────────────────────────

      const metricDefs = await listMetricDefinitions(resourceId);
      if (metricDefs.error) errors.push(metricDefs.error);
      permissionsCheck.metrics = !metricDefs.error;

      const { selected: selectedMetrics, all: allMetricDefs } = sortAndSelectMetrics(metricDefs.definitions, MAX_METRICS);

      // Resolve parent resource if applicable (e.g., App Service → App Service Plan)
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

      // Discover parent metrics too
      let parentMetricNames: string[] = [];
      if (parentResourceId) {
        const parentDefs = await listMetricDefinitions(parentResourceId);
        if (parentDefs.error) errors.push(parentDefs.error);
        const parentSorted = sortAndSelectMetrics(parentDefs.definitions, MAX_METRICS);
        parentMetricNames = parentSorted.selected;
      }

      // ── Phase 3: Gather ALL Signals in Parallel ───────────────────

      const metricPromises: Array<{ label: string; resourceId: string; promise: ReturnType<typeof getMetrics> }> = [];

      if (selectedMetrics.length > 0) {
        metricPromises.push({
          label: resourceName,
          resourceId,
          promise: getMetrics(resourceId, selectedMetrics, timeframeHours, "PT5M"),
        });
      }

      if (parentResourceId && parentMetricNames.length > 0) {
        metricPromises.push({
          label: `${parentLabel ?? "parent"}`,
          resourceId: parentResourceId,
          promise: getMetrics(parentResourceId, parentMetricNames, timeframeHours, "PT5M"),
        });
      }

      const [healthResult, activityResult, ...metricResults] = await Promise.all([
        getResourceHealth(subscription, resourceId),
        getActivityLogs(subscription, timeframeHours, resourceId),
        ...metricPromises.map((m) => m.promise),
      ]);

      // Track permissions from results
      permissionsCheck.resourceHealth = !healthResult.error;
      permissionsCheck.activityLog = !activityResult.error;

      // ── Phase 4: Process Health ───────────────────────────────────

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

      // ── Phase 5: Process Activity Log ─────────────────────────────

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

      // ── Phase 6: Process Metrics ──────────────────────────────────

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

      // ── Phase 7: Discover Dependencies (same as investigate.ts) ───

      interface DepHealth { name: string; type: string; health: string; relationship: string }
      const dependencies: DepHealth[] = [];

      if (resolvedRG) {
        const depResourceIds: Array<{ id: string; name: string; type: string; relationship: string }> = [];

        if (resourceType.toLowerCase() === "microsoft.web/sites") {
          // For App Services: check app settings and connection strings for references
          const configQuery = `Resources
| where type =~ 'microsoft.web/sites' and name =~ '${resourceName}' and resourceGroup =~ '${resolvedRG}'
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
                const serverMatch = val.match(/(?:Server|Data Source|AccountEndpoint)=(?:tcp:)?([^;,]+)/i);
                if (serverMatch) {
                  const host = serverMatch[1].split(".")[0];
                  referencedNames.add(host.toLowerCase());
                }
                const redisMatch = val.match(/([^.]+)\.redis\.cache\.windows\.net/i);
                if (redisMatch) referencedNames.add(redisMatch[1].toLowerCase());
                const storageMatch = val.match(/([^.]+)\.blob\.core\.windows\.net/i);
                if (storageMatch) referencedNames.add(storageMatch[1].toLowerCase());
                const cosmosMatch = val.match(/([^.]+)\.documents\.azure\.com/i);
                if (cosmosMatch) referencedNames.add(cosmosMatch[1].toLowerCase());
              }
            }
          }

          if (referencedNames.size > 0) {
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

            // Find child resources (e.g., SQL databases under a referenced server)
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

          // Fallback if no references found in app settings
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

      // ── Phase 8: Log Analytics ────────────────────────────────────

      let logData: LogData | null = null;

      if (resolvedRG) {
        const wsResult = await discoverWorkspaces(subscription, resolvedRG);
        permissionsCheck.logAnalytics = !wsResult.error;

        if (wsResult.workspaces.length > 0) {
          const ws = wsResult.workspaces[0];

          const [reqResult, excResult, depFail] = await Promise.all([
            queryLogAnalytics(ws.workspaceId, `AppRequests
| where TimeGenerated > ago(${timeframeHours}h)
| where Success == false
| summarize Count = count(), AvgDuration = round(avg(DurationMs), 1) by OperationName, ResultCode
| order by Count desc
| take 10`, timeframeHours),
            queryLogAnalytics(ws.workspaceId, `AppExceptions
| where TimeGenerated > ago(${timeframeHours}h)
| summarize Count = count() by ExceptionType, OuterMessage
| order by Count desc
| take 10`, timeframeHours),
            queryLogAnalytics(ws.workspaceId, `AppDependencies
| where TimeGenerated > ago(${timeframeHours}h)
| where Success == false
| summarize Count = count(), AvgDuration = round(avg(DurationMs), 1) by Target, DependencyType = Type, ResultCode
| order by Count desc
| take 10`, timeframeHours),
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

      // ── Phase 9: Baseline Comparison ──────────────────────────────

      const baselineMetrics: BaselineMetric[] = [];
      if (selectedMetrics.length > 0) {
        const baselineHours = baselineDays * 24;
        const baselineResult = await getMetrics(
          resourceId,
          selectedMetrics,
          baselineHours,
          "PT1H"
        );
        if (baselineResult.error) {
          errors.push(baselineResult.error);
        } else if (baselineResult.data) {
          for (const metric of baselineResult.data.metrics) {
            for (const ts of metric.timeseries) {
              if (!ts.data) continue;
              const dataPoints = ts.data
                .filter((dp) => dp.average !== undefined || dp.maximum !== undefined)
                .map((dp) => ({
                  timestamp: (dp as unknown as { timeStamp: Date }).timeStamp?.toISOString() ?? new Date().toISOString(),
                  average: dp.average ?? undefined,
                  maximum: dp.maximum ?? undefined,
                }));
              const bl = computeBaseline(dataPoints, metric.name);
              if (bl) baselineMetrics.push(bl);
            }
          }
        }
      }

      // Also pull baseline for parent metrics
      if (parentResourceId && parentMetricNames.length > 0) {
        const parentBaselineResult = await getMetrics(
          parentResourceId,
          parentMetricNames,
          baselineDays * 24,
          "PT1H"
        );
        if (parentBaselineResult.error) {
          errors.push(parentBaselineResult.error);
        } else if (parentBaselineResult.data) {
          for (const metric of parentBaselineResult.data.metrics) {
            for (const ts of metric.timeseries) {
              if (!ts.data) continue;
              const dataPoints = ts.data
                .filter((dp) => dp.average !== undefined || dp.maximum !== undefined)
                .map((dp) => ({
                  timestamp: (dp as unknown as { timeStamp: Date }).timeStamp?.toISOString() ?? new Date().toISOString(),
                  average: dp.average ?? undefined,
                  maximum: dp.maximum ?? undefined,
                }));
              const bl = computeBaseline(dataPoints, `${parentLabel ?? "parent"}/${metric.name}`);
              if (bl) baselineMetrics.push(bl);
            }
          }
        }
      }

      const anomalousCount = baselineMetrics.filter((m) => m.status === "anomalous").length;
      const elevatedCount = baselineMetrics.filter((m) => m.status === "elevated").length;
      let baselineOverallStatus: string;
      if (anomalousCount > 0) {
        baselineOverallStatus = `${anomalousCount} metric(s) anomalous`;
      } else if (elevatedCount > 0) {
        baselineOverallStatus = `${elevatedCount} metric(s) elevated`;
      } else {
        baselineOverallStatus = "All metrics within normal range";
      }

      // ── Phase 10: Alert Recommendations (dynamic) ─────────────────

      const alertRecommendations: AlertRecommendation[] = generateAlerts
        ? generateAlertRecommendations(allMetricDefs, metricSummaries)
        : [];

      // ── Phase 11: Timing ──────────────────────────────────────────

      const durationMs = Date.now() - startTime;
      const triageDuration = `${(durationMs / 1000).toFixed(1)}s`;
      const timestamp = new Date().toISOString();

      // Build permissions summary
      const accessibleAPIs: string[] = [];
      const inaccessibleAPIs: string[] = [];
      if (permissionsCheck.resourceGraph) accessibleAPIs.push("Resource Graph");
      else inaccessibleAPIs.push("Resource Graph");
      if (permissionsCheck.resourceHealth) accessibleAPIs.push("Resource Health");
      else inaccessibleAPIs.push("Resource Health");
      if (permissionsCheck.activityLog) accessibleAPIs.push("Activity Log");
      else inaccessibleAPIs.push("Activity Log");
      if (permissionsCheck.metrics) accessibleAPIs.push("Metrics");
      else inaccessibleAPIs.push("Metrics");
      if (permissionsCheck.logAnalytics) accessibleAPIs.push("Log Analytics");
      else inaccessibleAPIs.push("Log Analytics");

      permissionsCheck.summary =
        inaccessibleAPIs.length === 0
          ? "All APIs accessible — full diagnostic data available."
          : `${accessibleAPIs.length}/5 APIs accessible. Inaccessible: ${inaccessibleAPIs.join(", ")}.`;

      // ── Phase 12: Journal Save ────────────────────────────────────

      let journalSaved = false;
      let journalPath: string | undefined;

      if (saveToJournal) {
        try {
          ensureJournalDir();
          const now = new Date();
          const filename = `triage-${sanitizeResourceName(resourceName)}-${formatDateForFilename(now)}.md`;
          journalPath = join(JOURNAL_DIR, filename);

          const markdownContent = buildJournalMarkdown({
            resource: resourceName,
            resourceType,
            resourceGroup: resolvedRG,
            timestamp,
            triageDuration,
            currentHealth,
            healthDetails,
            symptom,
            permissions: permissionsCheck,
            metrics: metricSummaries.length > 0 ? metricSummaries : "No metric data available.",
            recentChanges: recentChanges.length > 0 ? recentChanges : "No notable changes.",
            logAnalytics: logData
              ? (logData.failedRequests.length > 0 || logData.exceptions.length > 0 || logData.dependencyFailures.length > 0
                  ? logData
                  : { workspace: logData.workspace, summary: "No failed requests, exceptions, or dependency failures found." })
              : null,
            dependencies,
            baseline: {
              overallStatus: baselineOverallStatus,
              metrics: baselineMetrics,
              lookbackDays: baselineDays,
            },
            alertRecommendations,
            errors,
          });

          writeFileSync(journalPath, markdownContent, "utf-8");
          journalSaved = true;
        } catch {
          journalSaved = false;
        }
      }

      // ── Phase 13: Build Response — ALL raw data, no opinions ──────

      const response: Record<string, unknown> = {
        // Header
        resource: resourceName,
        resourceType,
        resourceGroup: resolvedRG,
        subscription,
        timestamp,
        triageDuration,
        executionTimeMs: durationMs,

        // Permissions
        permissions: permissionsCheck,

        // Health
        currentHealth,
      };

      if (healthDetails) response.healthDetails = healthDetails;
      if (symptom) response.reportedSymptom = symptom;

      // Metrics
      if (metricSummaries.length > 0) {
        response.metrics = metricSummaries;
      } else if (selectedMetrics.length === 0 && metricDefs.definitions.length === 0) {
        response.metrics = "This resource type does not emit Azure Monitor metrics.";
      } else {
        response.metrics = `Metrics requested (${selectedMetrics.join(", ")}) but no data returned for the ${timeframeHours}h window.`;
      }

      // Additional metrics not pulled
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

      // Dependencies
      if (dependencies.length > 0) {
        response.dependencies = dependencies;
      }

      // Baseline
      response.baseline = {
        overallStatus: baselineOverallStatus,
        metrics: baselineMetrics,
        lookbackDays: baselineDays,
      };

      // Alert recommendations
      if (alertRecommendations.length > 0) {
        response.alertRecommendations = alertRecommendations;
      }

      // Journal
      response.journalSaved = journalSaved;
      if (journalPath) response.journalPath = journalPath;

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
