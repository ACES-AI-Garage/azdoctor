import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/tools/healthcheck.ts
import { z } from "zod";

// src/utils/azure-client.ts
import { DefaultAzureCredential } from "@azure/identity";
import {
  ResourceGraphClient
} from "@azure/arm-resourcegraph";
import { MicrosoftResourceHealth } from "@azure/arm-resourcehealth";
import { MonitorClient } from "@azure/arm-monitor";
import { LogsQueryClient, MetricsQueryClient } from "@azure/monitor-query";
import { MicrosoftSupport } from "@azure/arm-support";
var credentialInstance = null;
function getCredential() {
  if (!credentialInstance) {
    credentialInstance = new DefaultAzureCredential();
  }
  return credentialInstance;
}
function classifyError(err, context) {
  const e = err;
  const statusCode = e.statusCode ?? 0;
  const code = e.code ?? "UNKNOWN";
  const message = e.message ?? String(err);
  if (statusCode === 403 || code === "AuthorizationFailed") {
    return {
      code: "FORBIDDEN",
      message: `Access denied for ${context}: ${message}`,
      roleRecommendation: getRoleRecommendation(context)
    };
  }
  if (statusCode === 429 || code === "TooManyRequests") {
    return {
      code: "THROTTLED",
      message: `Rate-limited on ${context}: ${message}`
    };
  }
  return { code, message: `${context} failed: ${message}` };
}
function getRoleRecommendation(context) {
  const recommendations = {
    resourceHealth: "Assign Reader role on the subscription or resource.",
    activityLog: "Assign Reader role (includes Microsoft.Insights/eventtypes/*).",
    resourceGraph: "Assign Reader role \u2014 Resource Graph returns only resources the identity can read.",
    metrics: "Assign Reader role on the target resource.",
    logAnalytics: "Assign Log Analytics Reader on the workspace, or ensure workspace access mode allows resource-context queries.",
    support: "Assign Support Request Contributor role (requires paid support plan: Pro Direct/Premier/Unified)."
  };
  return recommendations[context] ?? "Check your RBAC role assignments on the target scope.";
}
async function withRetry(fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const e = err;
      if (e.statusCode === 429 && attempt < maxRetries) {
        const delayMs = Math.min(1e3 * 2 ** attempt, 16e3);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
function createResourceGraphClient() {
  return new ResourceGraphClient(getCredential());
}
function createResourceHealthClient(subscriptionId) {
  return new MicrosoftResourceHealth(getCredential(), subscriptionId);
}
function createMonitorClient(subscriptionId) {
  return new MonitorClient(getCredential(), subscriptionId);
}
function createMetricsQueryClient() {
  return new MetricsQueryClient(getCredential());
}
async function queryResourceGraph(subscriptions, query) {
  try {
    const client = createResourceGraphClient();
    const request = {
      subscriptions,
      query,
      options: { resultFormat: "objectArray" }
    };
    const response = await withRetry(() => client.resources(request));
    const data = response.data ?? [];
    return { resources: data, totalRecords: response.totalRecords ?? data.length };
  } catch (err) {
    return { resources: [], totalRecords: 0, error: classifyError(err, "resourceGraph") };
  }
}
async function getResourceHealth(subscriptionId, resourceUri) {
  try {
    const client = createResourceHealthClient(subscriptionId);
    const status = await withRetry(
      () => client.availabilityStatuses.getByResource(resourceUri)
    );
    return { statuses: [status] };
  } catch (err) {
    return { statuses: [], error: classifyError(err, "resourceHealth") };
  }
}
async function batchResourceHealth(subscriptionId, resourceGroup) {
  try {
    const client = createResourceHealthClient(subscriptionId);
    const statuses = [];
    const iter = resourceGroup ? client.availabilityStatuses.listByResourceGroup(resourceGroup) : client.availabilityStatuses.listBySubscriptionId();
    for await (const status of iter) {
      statuses.push(status);
    }
    return { statuses };
  } catch (err) {
    return { statuses: [], error: classifyError(err, "resourceHealth") };
  }
}
async function getActivityLogs(subscriptionId, hoursBack = 24, resourceUri, resourceGroup) {
  try {
    const client = createMonitorClient(subscriptionId);
    const now = /* @__PURE__ */ new Date();
    const start = new Date(now.getTime() - hoursBack * 60 * 60 * 1e3);
    let filter = `eventTimestamp ge '${start.toISOString()}' and eventTimestamp le '${now.toISOString()}'`;
    if (resourceUri) {
      filter += ` and resourceUri eq '${resourceUri}'`;
    } else if (resourceGroup) {
      filter += ` and resourceGroupName eq '${resourceGroup}'`;
    }
    const events = [];
    for await (const event of client.activityLogs.list(filter)) {
      events.push(event);
    }
    return { events };
  } catch (err) {
    return { events: [], error: classifyError(err, "activityLog") };
  }
}
async function getMetrics(resourceUri, metricNames, timespanHours = 24, granularity = "PT1H") {
  try {
    const client = createMetricsQueryClient();
    const now = /* @__PURE__ */ new Date();
    const start = new Date(now.getTime() - timespanHours * 60 * 60 * 1e3);
    const timespan = { startTime: start, endTime: now };
    const result = await withRetry(
      () => client.queryResource(resourceUri, metricNames, {
        timespan,
        granularity,
        aggregations: ["Average", "Maximum"]
      })
    );
    return { data: result };
  } catch (err) {
    return { data: null, error: classifyError(err, "metrics") };
  }
}

// src/tools/healthcheck.ts
function registerHealthcheck(server2) {
  server2.tool(
    "azdoctor_healthcheck",
    "Scan a subscription or resource group for health issues, anomalies, and risks. Returns a risk-scored summary of findings across all resources.",
    {
      subscription: z.string().describe("Azure subscription ID"),
      resourceGroup: z.string().optional().describe("Scope to a specific resource group"),
      severity: z.enum(["critical", "warning", "info"]).default("warning").describe("Minimum severity threshold for reported findings")
    },
    async ({ subscription, resourceGroup, severity }) => {
      const findings = [];
      const errors = [];
      const rgQuery = resourceGroup ? `Resources | where resourceGroup =~ '${resourceGroup}' | project id, name, type, location, resourceGroup` : `Resources | project id, name, type, location, resourceGroup`;
      const resourceList = await queryResourceGraph([subscription], rgQuery);
      if (resourceList.error) errors.push(resourceList.error);
      const scannedResources = resourceList.totalRecords;
      const healthResult = await batchResourceHealth(subscription, resourceGroup);
      if (healthResult.error) {
        errors.push(healthResult.error);
      } else {
        for (const status of healthResult.statuses) {
          const state = status.properties?.availabilityState;
          const resourceName = status.name ?? status.id ?? "unknown";
          const resourceType = status.type ?? "unknown";
          if (state === "Unavailable") {
            findings.push({
              severity: "critical",
              resource: resourceName,
              resourceType,
              issue: `Resource is unavailable: ${status.properties?.summary ?? "No details"}`,
              evidence: {
                availabilityState: state,
                reasonType: status.properties?.reasonType,
                detailedStatus: status.properties?.detailedStatus
              },
              recommendation: status.properties?.recommendedActions?.[0]?.action ?? "Check Azure Service Health for platform events, then review recent changes."
            });
          } else if (state === "Degraded") {
            findings.push({
              severity: "critical",
              resource: resourceName,
              resourceType,
              issue: `Resource is degraded: ${status.properties?.summary ?? "No details"}`,
              evidence: {
                availabilityState: state,
                reasonType: status.properties?.reasonType
              },
              recommendation: "Investigate recent deployments or configuration changes. Check dependent resources."
            });
          }
        }
      }
      const activityResult = await getActivityLogs(subscription, 24, void 0, resourceGroup);
      if (activityResult.error) {
        errors.push(activityResult.error);
      } else {
        const changesByResource = /* @__PURE__ */ new Map();
        let failedDeployments = 0;
        for (const event of activityResult.events) {
          const resId = event.resourceId ?? "unknown";
          changesByResource.set(resId, (changesByResource.get(resId) ?? 0) + 1);
          if (event.status?.value === "Failed" && event.operationName?.value?.includes("deployments")) {
            failedDeployments++;
            const resourceName = event.resourceId?.split("/").pop() ?? "unknown";
            findings.push({
              severity: "warning",
              resource: resourceName,
              resourceType: "Microsoft.Resources/deployments",
              issue: `Failed deployment: ${event.operationName?.localizedValue ?? event.operationName?.value ?? "unknown operation"}`,
              evidence: {
                status: event.status?.value,
                timestamp: event.eventTimestamp?.toISOString(),
                caller: event.caller
              },
              recommendation: "Review deployment logs for error details. Check ARM template or deployment parameters."
            });
          }
        }
        for (const [resId, count] of changesByResource) {
          if (count > 20) {
            const resourceName = resId.split("/").pop() ?? "unknown";
            findings.push({
              severity: "warning",
              resource: resourceName,
              resourceType: "unknown",
              issue: `High change velocity: ${count} changes in last 24h`,
              evidence: { changeCount: count, resourceId: resId },
              recommendation: "Review whether repeated changes indicate a flapping deployment or configuration drift."
            });
          }
        }
      }
      const severityRank = {
        critical: 3,
        warning: 2,
        info: 1
      };
      const minRank = severityRank[severity] ?? 2;
      const filtered = findings.filter(
        (f) => (severityRank[f.severity] ?? 0) >= minRank
      );
      const criticalCount = filtered.filter(
        (f) => f.severity === "critical"
      ).length;
      const warningCount = filtered.filter(
        (f) => f.severity === "warning"
      ).length;
      const infoCount = filtered.filter((f) => f.severity === "info").length;
      const riskScore = Math.min(
        100,
        criticalCount * 30 + warningCount * 10 + infoCount * 2
      );
      const healthyCount = Math.max(0, scannedResources - criticalCount - warningCount);
      const response = {
        riskScore,
        summary: `${criticalCount} critical, ${warningCount} warning, ${healthyCount} healthy`,
        findings: filtered,
        scannedResources,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        errors: errors.length > 0 ? errors : void 0
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(response, null, 2) }
        ]
      };
    }
  );
}

// src/tools/investigate.ts
import { z as z2 } from "zod";

// src/utils/correlator.ts
var ANOMALY_SOURCES = /* @__PURE__ */ new Set(["ResourceHealth", "Metrics", "ServiceHealth"]);
var CHANGE_SOURCES = /* @__PURE__ */ new Set(["ActivityLog"]);
function correlateTimelines(events, windowMinutes = 15) {
  if (events.length === 0) {
    return {
      timeline: [],
      earliestAnomaly: null,
      precedingChanges: [],
      likelyCause: "No diagnostic events were collected \u2014 insufficient data for correlation."
    };
  }
  const sorted = [...events].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );
  const anomalies = sorted.filter((e) => ANOMALY_SOURCES.has(e.source));
  const changes = sorted.filter((e) => CHANGE_SOURCES.has(e.source));
  const earliestAnomaly = anomalies.length > 0 ? anomalies[0] : null;
  if (!earliestAnomaly) {
    if (changes.length > 0) {
      return {
        timeline: sorted,
        earliestAnomaly: null,
        precedingChanges: changes,
        likelyCause: `${changes.length} change(s) detected but no anomalies observed. Resources may be healthy, or monitoring data may be incomplete.`
      };
    }
    return {
      timeline: sorted,
      earliestAnomaly: null,
      precedingChanges: [],
      likelyCause: "No anomalies or changes detected in the investigation window."
    };
  }
  const anomalyTime = new Date(earliestAnomaly.time).getTime();
  const windowMs = windowMinutes * 60 * 1e3;
  const precedingChanges = changes.filter((c) => {
    const changeTime = new Date(c.time).getTime();
    return changeTime <= anomalyTime && anomalyTime - changeTime <= windowMs;
  });
  const likelyCause = buildCausalNarrative(
    earliestAnomaly,
    precedingChanges,
    anomalies,
    windowMinutes
  );
  return { timeline: sorted, earliestAnomaly, precedingChanges, likelyCause };
}
function buildCausalNarrative(earliestAnomaly, precedingChanges, allAnomalies, windowMinutes) {
  const parts = [];
  if (precedingChanges.length > 0) {
    const change = precedingChanges[precedingChanges.length - 1];
    const changeTime = new Date(change.time);
    const anomalyTime = new Date(earliestAnomaly.time);
    const gapMinutes = Math.round(
      (anomalyTime.getTime() - changeTime.getTime()) / 6e4
    );
    parts.push(
      `A change at ${change.time} ("${change.event}"${change.actor ? ` by ${change.actor}` : ""}) preceded the first anomaly by ${gapMinutes} minute(s).`
    );
    parts.push(
      `First anomaly at ${earliestAnomaly.time}: "${earliestAnomaly.event}" (source: ${earliestAnomaly.source}).`
    );
    if (allAnomalies.length > 1) {
      parts.push(
        `${allAnomalies.length - 1} additional anomaly event(s) followed within the investigation window.`
      );
    }
    parts.push(
      `Correlation: the change likely triggered the observed anomalies (${gapMinutes}min gap, within ${windowMinutes}min correlation window).`
    );
  } else {
    parts.push(
      `First anomaly at ${earliestAnomaly.time}: "${earliestAnomaly.event}" (source: ${earliestAnomaly.source}).`
    );
    parts.push(
      `No preceding changes found within the ${windowMinutes}-minute correlation window.`
    );
    parts.push(
      "This may indicate a platform-level issue, gradual resource exhaustion, or changes made outside the monitored scope."
    );
  }
  return parts.join(" ");
}
function detectMetricAnomalies(resourceId, metricName, dataPoints, thresholds) {
  const events = [];
  for (const dp of dataPoints) {
    const value = dp.maximum ?? dp.average;
    if (value === void 0) continue;
    if (value >= thresholds.criticalPct) {
      events.push({
        time: dp.timestamp,
        event: `${metricName} at ${value.toFixed(1)}% (critical threshold: ${thresholds.criticalPct}%)`,
        source: "Metrics",
        resource: resourceId,
        severity: "critical"
      });
    } else if (value >= thresholds.warningPct) {
      events.push({
        time: dp.timestamp,
        event: `${metricName} at ${value.toFixed(1)}% (warning threshold: ${thresholds.warningPct}%)`,
        source: "Metrics",
        resource: resourceId,
        severity: "warning"
      });
    }
  }
  return events;
}

// src/tools/investigate.ts
var METRIC_MAP = {
  "microsoft.web/sites": {
    names: ["Http5xx", "HttpResponseTime", "CpuPercentage", "MemoryPercentage"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.sql/servers/databases": {
    names: ["dtu_consumption_percent", "connection_failed", "deadlock"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.compute/virtualmachines": {
    names: ["Percentage CPU", "Available Memory Bytes"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.documentdb/databaseaccounts": {
    names: ["TotalRequestUnits", "NormalizedRUConsumption"],
    warningPct: 80,
    criticalPct: 95
  },
  "microsoft.cache/redis": {
    names: ["percentProcessorTime", "usedmemorypercentage", "serverLoad"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.storage/storageaccounts": {
    names: ["Availability", "SuccessE2ELatency"],
    warningPct: 80,
    criticalPct: 90
  }
};
function registerInvestigate(server2) {
  server2.tool(
    "azdoctor_investigate",
    "Investigate a specific Azure resource or incident. Performs multi-signal correlation across Resource Health, Activity Logs, Metrics, and dependent resources to identify root cause.",
    {
      resource: z2.string().describe("Resource name or full Azure resource ID"),
      subscription: z2.string().describe("Azure subscription ID"),
      resourceGroup: z2.string().optional().describe("Resource group name (helps resolve resource ID faster)"),
      timeframeHours: z2.number().default(24).describe("How many hours back to investigate"),
      symptom: z2.string().optional().describe(
        'User-described symptom (e.g., "slow", "500 errors", "unreachable")'
      )
    },
    async ({
      resource,
      subscription,
      resourceGroup,
      timeframeHours,
      symptom
    }) => {
      const errors = [];
      const allEvents = [];
      let resourceId = resource;
      let resourceType = "Unknown";
      let resourceName = resource;
      if (!resource.startsWith("/subscriptions/")) {
        const rgFilter = resourceGroup ? `| where resourceGroup =~ '${resourceGroup}'` : "";
        const resolveQuery = `Resources | where name =~ '${resource}' ${rgFilter} | project id, name, type, location, resourceGroup | take 1`;
        const resolved = await queryResourceGraph([subscription], resolveQuery);
        if (resolved.resources.length > 0) {
          const r = resolved.resources[0];
          resourceId = r.id ?? resource;
          resourceType = r.type ?? "Unknown";
          resourceName = r.name ?? resource;
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
      const [healthResult, activityResult, metricsResult] = await Promise.all([
        // 2. Check Resource Health
        getResourceHealth(subscription, resourceId),
        // 3. Pull Activity Log for this resource
        getActivityLogs(subscription, timeframeHours, resourceId),
        // 4. Pull metrics (if we know the resource type)
        (async () => {
          const typeKey = resourceType.toLowerCase();
          const metricConfig = METRIC_MAP[typeKey];
          if (metricConfig) {
            return getMetrics(
              resourceId,
              metricConfig.names,
              timeframeHours
            );
          }
          return { data: null, error: void 0 };
        })()
      ]);
      let currentHealth = "Unknown";
      if (healthResult.error) {
        errors.push(healthResult.error);
      } else if (healthResult.statuses.length > 0) {
        const status = healthResult.statuses[0];
        currentHealth = status.properties?.availabilityState ?? "Unknown";
        if (currentHealth !== "Available") {
          allEvents.push({
            time: (/* @__PURE__ */ new Date()).toISOString(),
            event: `Health status: ${currentHealth} \u2014 ${status.properties?.summary ?? ""}`,
            source: "ResourceHealth",
            resource: resourceName,
            severity: currentHealth === "Unavailable" ? "critical" : "warning"
          });
        }
      }
      if (activityResult.error) {
        errors.push(activityResult.error);
      } else {
        for (const event of activityResult.events) {
          const opName = event.operationName?.localizedValue ?? event.operationName?.value ?? "Unknown operation";
          const status = event.status?.value ?? "";
          const timestamp = event.eventTimestamp?.toISOString() ?? (/* @__PURE__ */ new Date()).toISOString();
          allEvents.push({
            time: timestamp,
            event: `${opName} (${status})`,
            source: "ActivityLog",
            resource: resourceName,
            actor: event.caller,
            severity: status === "Failed" ? "warning" : "info"
          });
        }
      }
      if (metricsResult.error) {
        errors.push(metricsResult.error);
      } else if (metricsResult.data) {
        const typeKey = resourceType.toLowerCase();
        const metricConfig = METRIC_MAP[typeKey];
        if (metricConfig) {
          for (const metric of metricsResult.data.metrics) {
            for (const ts of metric.timeseries) {
              if (!ts.data) continue;
              const dataPoints = ts.data.filter((dp) => dp.average !== void 0 || dp.maximum !== void 0).map((dp) => ({
                timestamp: dp.timeStamp?.toISOString() ?? (/* @__PURE__ */ new Date()).toISOString(),
                average: dp.average ?? void 0,
                maximum: dp.maximum ?? void 0
              }));
              const anomalies = detectMetricAnomalies(
                resourceId,
                metric.name,
                dataPoints,
                {
                  warningPct: metricConfig.warningPct,
                  criticalPct: metricConfig.criticalPct
                }
              );
              allEvents.push(...anomalies);
            }
          }
        }
      }
      const dependentResources = [];
      if (resourceType.toLowerCase() === "microsoft.web/sites") {
        const depQuery = `Resources | where resourceGroup =~ '${resourceGroup ?? ""}' and (type =~ 'Microsoft.Sql/servers/databases' or type =~ 'Microsoft.Cache/Redis' or type =~ 'Microsoft.DocumentDB/databaseAccounts') | project id, name, type`;
        const deps = await queryResourceGraph([subscription], depQuery);
        for (const dep of deps.resources) {
          const depId = dep.id;
          const depHealth = await getResourceHealth(subscription, depId);
          const depState = depHealth.statuses[0]?.properties?.availabilityState ?? "Unknown";
          dependentResources.push({
            name: dep.name,
            type: dep.type,
            health: depState,
            concern: depState !== "Available" ? `${dep.name} is ${depState}` : void 0
          });
          if (depState !== "Available") {
            allEvents.push({
              time: (/* @__PURE__ */ new Date()).toISOString(),
              event: `Dependent resource ${dep.name} health: ${depState}`,
              source: "ResourceHealth",
              resource: dep.name,
              severity: "warning"
            });
          }
        }
      }
      const correlation = correlateTimelines(allEvents);
      const now = /* @__PURE__ */ new Date();
      const windowStart = new Date(
        now.getTime() - timeframeHours * 60 * 60 * 1e3
      );
      const response = {
        resource: resourceName,
        resourceType,
        currentHealth,
        investigationWindow: `${windowStart.toISOString()} to ${now.toISOString()}`,
        symptom: symptom ?? null,
        timeline: correlation.timeline,
        likelyCause: correlation.likelyCause,
        earliestAnomaly: correlation.earliestAnomaly,
        precedingChanges: correlation.precedingChanges,
        dependentResources,
        recommendedActions: buildRecommendations(
          currentHealth,
          correlation,
          dependentResources,
          symptom
        ),
        permissionGaps: errors.filter((e) => e.code === "FORBIDDEN").map((e) => ({
          api: e.message,
          recommendation: e.roleRecommendation
        })),
        errors: errors.length > 0 ? errors : void 0
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(response, null, 2) }
        ]
      };
    }
  );
}
function buildRecommendations(currentHealth, correlation, dependentResources, symptom) {
  const actions = [];
  if (correlation.precedingChanges.length > 0) {
    const lastChange = correlation.precedingChanges[correlation.precedingChanges.length - 1];
    actions.push(
      `Review the change at ${lastChange.time}: "${lastChange.event}"${lastChange.actor ? ` (by ${lastChange.actor})` : ""}`
    );
    actions.push("Consider rolling back the change if immediate mitigation is needed.");
  }
  if (currentHealth === "Unavailable" || currentHealth === "Degraded") {
    actions.push(
      "Check Azure Service Health for ongoing platform incidents in the resource's region."
    );
  }
  const unhealthyDeps = dependentResources.filter(
    (d) => d.health !== "Available"
  );
  if (unhealthyDeps.length > 0) {
    for (const dep of unhealthyDeps) {
      actions.push(
        `Investigate dependent resource ${dep.name} (${dep.type}) \u2014 currently ${dep.health}.`
      );
    }
  }
  if (actions.length === 0) {
    actions.push(
      "No clear root cause identified from available signals.",
      "Search Microsoft Learn docs for troubleshooting guidance specific to this resource type and symptom.",
      "Check if there are Log Analytics workspaces with additional diagnostic data."
    );
  }
  return actions;
}

// src/tools/rca.ts
import { z as z3 } from "zod";

// src/utils/formatters.ts
function formatRCA(input) {
  const timelineRows = input.timeline.length > 0 ? input.timeline.map(
    (e) => `| ${e.time} | ${e.event} | ${e.source} |${e.resource ? ` ${e.resource}` : ""}`
  ).join("\n") : "| \u2014 | No events recorded | \u2014 |";
  const affectedList = input.impact.affectedResources.length > 0 ? input.impact.affectedResources.join(", ") : "None identified";
  const remediationList = input.remediationApplied.length > 0 ? input.remediationApplied.map((r) => `- ${r}`).join("\n") : "- None documented";
  const recommendationList = input.recommendations.length > 0 ? input.recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n") : "1. No additional recommendations";
  return `## Root Cause Analysis
**Incident:** ${input.resource} (${input.resourceType})
**Subscription:** ${input.subscription}
**Window:** ${input.incidentStart} \u2014 ${input.incidentEnd ?? "ongoing"}
**Generated:** ${(/* @__PURE__ */ new Date()).toISOString()}

### Timeline
| Time (UTC) | Event | Source |
|------------|-------|--------|
${timelineRows}

### Root Cause
${input.rootCause}

### Impact
- Duration: ${input.impact.duration}
${input.impact.errorRate ? `- Error rate: ${input.impact.errorRate}` : ""}
- Affected resources: ${affectedList}

### Remediation Applied
${remediationList}

### Recommended Follow-Up
${recommendationList}

---
*Generated by AZ Doctor v0.1.0*`;
}

// src/tools/rca.ts
var METRIC_MAP2 = {
  "microsoft.web/sites": {
    names: ["Http5xx", "HttpResponseTime", "CpuPercentage", "MemoryPercentage"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.sql/servers/databases": {
    names: ["dtu_consumption_percent", "connection_failed", "deadlock"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.compute/virtualmachines": {
    names: ["Percentage CPU", "Available Memory Bytes"],
    warningPct: 80,
    criticalPct: 90
  }
};
function registerRca(server2) {
  server2.tool(
    "azdoctor_rca",
    "Generate a structured Root Cause Analysis document from investigation results. Produces markdown suitable for ServiceNow, post-incident reviews, or export.",
    {
      resource: z3.string().describe("Resource name or full Azure resource ID"),
      subscription: z3.string().describe("Azure subscription ID"),
      incidentStart: z3.string().optional().describe("ISO timestamp for incident start"),
      incidentEnd: z3.string().optional().describe("ISO timestamp for incident resolution"),
      includeRecommendations: z3.boolean().default(true).describe("Whether to include follow-up recommendations")
    },
    async ({
      resource,
      subscription,
      incidentStart,
      incidentEnd,
      includeRecommendations
    }) => {
      const errors = [];
      const allEvents = [];
      const now = /* @__PURE__ */ new Date();
      const end = incidentEnd ? new Date(incidentEnd) : now;
      const start = incidentStart ? new Date(incidentStart) : new Date(end.getTime() - 24 * 60 * 60 * 1e3);
      const hoursBack = Math.max(
        1,
        (end.getTime() - start.getTime()) / (60 * 60 * 1e3)
      );
      let resourceId = resource;
      let resourceType = "Unknown";
      let resourceName = resource;
      if (!resource.startsWith("/subscriptions/")) {
        const resolveQuery = `Resources | where name =~ '${resource}' | project id, name, type, location, resourceGroup | take 1`;
        const resolved = await queryResourceGraph([subscription], resolveQuery);
        if (resolved.resources.length > 0) {
          const r = resolved.resources[0];
          resourceId = r.id ?? resource;
          resourceType = r.type ?? "Unknown";
          resourceName = r.name ?? resource;
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
      const [healthResult, activityResult, metricsResult] = await Promise.all([
        getResourceHealth(subscription, resourceId),
        getActivityLogs(subscription, hoursBack, resourceId),
        (async () => {
          const typeKey = resourceType.toLowerCase();
          const metricConfig = METRIC_MAP2[typeKey];
          if (metricConfig) {
            return getMetrics(resourceId, metricConfig.names, hoursBack);
          }
          return { data: null, error: void 0 };
        })()
      ]);
      let currentHealth = "Unknown";
      if (healthResult.error) {
        errors.push(healthResult.error);
      } else if (healthResult.statuses.length > 0) {
        currentHealth = healthResult.statuses[0].properties?.availabilityState ?? "Unknown";
        if (currentHealth !== "Available") {
          allEvents.push({
            time: (/* @__PURE__ */ new Date()).toISOString(),
            event: `Health status: ${currentHealth}`,
            source: "ResourceHealth",
            resource: resourceName,
            severity: currentHealth === "Unavailable" ? "critical" : "warning"
          });
        }
      }
      if (activityResult.error) {
        errors.push(activityResult.error);
      } else {
        for (const event of activityResult.events) {
          const opName = event.operationName?.localizedValue ?? event.operationName?.value ?? "Unknown";
          allEvents.push({
            time: event.eventTimestamp?.toISOString() ?? (/* @__PURE__ */ new Date()).toISOString(),
            event: `${opName} (${event.status?.value ?? "unknown"})`,
            source: "ActivityLog",
            resource: resourceName,
            actor: event.caller
          });
        }
      }
      if (metricsResult.data) {
        const typeKey = resourceType.toLowerCase();
        const metricConfig = METRIC_MAP2[typeKey];
        if (metricConfig) {
          for (const metric of metricsResult.data.metrics) {
            for (const ts of metric.timeseries) {
              if (!ts.data) continue;
              const dataPoints = ts.data.filter((dp) => dp.average !== void 0 || dp.maximum !== void 0).map((dp) => ({
                timestamp: dp.timeStamp?.toISOString() ?? (/* @__PURE__ */ new Date()).toISOString(),
                average: dp.average ?? void 0,
                maximum: dp.maximum ?? void 0
              }));
              allEvents.push(
                ...detectMetricAnomalies(resourceId, metric.name, dataPoints, {
                  warningPct: metricConfig.warningPct,
                  criticalPct: metricConfig.criticalPct
                })
              );
            }
          }
        }
      }
      const correlation = correlateTimelines(allEvents);
      let duration = "Unknown";
      if (incidentStart && incidentEnd) {
        const durationMs = new Date(incidentEnd).getTime() - new Date(incidentStart).getTime();
        const hours = Math.floor(durationMs / 36e5);
        const minutes = Math.round(durationMs % 36e5 / 6e4);
        duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes} minutes`;
      } else if (incidentStart) {
        duration = "Ongoing";
      }
      const affectedResources = [resourceName];
      const depResources = new Set(
        correlation.timeline.filter((e) => e.resource && e.resource !== resourceName).map((e) => e.resource)
      );
      affectedResources.push(...depResources);
      const recommendations = [];
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
      const rca = formatRCA({
        resource: resourceName,
        resourceType,
        subscription,
        incidentStart: incidentStart ?? start.toISOString(),
        incidentEnd: incidentEnd ?? (currentHealth === "Available" ? now.toISOString() : void 0),
        timeline: correlation.timeline,
        rootCause: correlation.likelyCause,
        impact: {
          duration,
          affectedResources
        },
        remediationApplied: incidentEnd ? ["Incident was resolved (end time provided)."] : ["Incident may still be ongoing."],
        recommendations
      });
      return {
        content: [{ type: "text", text: rca }]
      };
    }
  );
}

// src/tools/checkPermissions.ts
import { z as z4 } from "zod";
function registerCheckPermissions(server2) {
  server2.tool(
    "azdoctor_check_permissions",
    "Detect what diagnostic data the current credentials can access and recommend role upgrades for fuller diagnostics.",
    {
      subscription: z4.string().describe("Azure subscription ID")
    },
    async ({ subscription }) => {
      const stubResponse = {
        subscription,
        checks: {
          resourceHealth: { accessible: false, status: "not_checked" },
          activityLog: { accessible: false, status: "not_checked" },
          logAnalytics: { accessible: false, status: "not_checked" },
          resourceGraph: { accessible: false, status: "not_checked" },
          supportApi: { accessible: false, status: "not_checked" }
        },
        recommendations: [
          "Permission checking not yet implemented \u2014 this is a stub response"
        ],
        _stub: true
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(stubResponse, null, 2)
          }
        ]
      };
    }
  );
}

// src/tools/draftTicket.ts
import { z as z5 } from "zod";
function registerDraftTicket(server2) {
  server2.tool(
    "azdoctor_draft_ticket",
    "Pre-populate a support ticket with diagnostic context from a prior investigation. Creates via Support API if accessible, otherwise generates a formatted draft for copy-paste.",
    {
      resource: z5.string().describe("Resource name or full Azure resource ID"),
      subscription: z5.string().describe("Azure subscription ID"),
      investigationSummary: z5.string().describe("Output from azdoctor_investigate to include as context"),
      severity: z5.enum(["A", "B", "C"]).optional().describe("Support ticket severity (A = critical, B = moderate, C = minimal)")
    },
    async ({ resource, subscription, investigationSummary, severity }) => {
      const stubResponse = {
        ticketDraft: {
          title: `Diagnostic Investigation: ${resource}`,
          severity: severity ?? "C",
          subscription,
          resource,
          description: investigationSummary,
          diagnosticContext: "Full diagnostic context would be attached here."
        },
        supportApiAccessible: false,
        message: "Ticket drafting not yet implemented \u2014 this is a stub response. Copy the draft above into Azure Portal > Help + Support.",
        _stub: true
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(stubResponse, null, 2)
          }
        ]
      };
    }
  );
}

// src/index.ts
var server = new McpServer({
  name: "azdoctor",
  version: "0.1.0"
});
registerHealthcheck(server);
registerInvestigate(server);
registerRca(server);
registerCheckPermissions(server);
registerDraftTicket(server);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((error) => {
  console.error("AZ Doctor MCP server failed to start:", error);
  process.exit(1);
});
