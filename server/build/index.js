import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/tools/healthcheck.ts
import { z } from "zod";

// src/utils/azure-client.ts
import { execSync } from "node:child_process";
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
var cachedSubscription = null;
async function resolveSubscription(explicit) {
  if (explicit) return explicit;
  if (cachedSubscription) return cachedSubscription;
  const envSub = process.env.AZURE_SUBSCRIPTION_ID;
  if (envSub) {
    cachedSubscription = envSub;
    return envSub;
  }
  try {
    const output = execSync("az account show --query id -o tsv", {
      encoding: "utf-8",
      timeout: 1e4,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    if (output) {
      cachedSubscription = output;
      return output;
    }
  } catch {
  }
  throw new Error(
    "No subscription ID found. Provide one explicitly, set AZURE_SUBSCRIPTION_ID, or run 'az login'."
  );
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
function createLogsQueryClient() {
  return new LogsQueryClient(getCredential());
}
function createMetricsQueryClient() {
  return new MetricsQueryClient(getCredential());
}
var resourceGraphCache = /* @__PURE__ */ new Map();
var RESOURCE_GRAPH_CACHE_TTL_MS = 6e4;
async function queryResourceGraph(subscriptions, query, skipCache = false) {
  const cacheKey = JSON.stringify({ subscriptions, query });
  if (!skipCache) {
    const cached = resourceGraphCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      return cached.result;
    }
  }
  try {
    const client = createResourceGraphClient();
    const request = {
      subscriptions,
      query,
      options: { resultFormat: "objectArray" }
    };
    const response = await withRetry(() => client.resources(request));
    const allData = response.data ?? [];
    const totalRecords = response.totalRecords ?? allData.length;
    const MAX_PAGES = 10;
    let skipToken = response.skipToken;
    let page = 1;
    while (skipToken && page < MAX_PAGES) {
      const pagedRequest = {
        subscriptions,
        query,
        options: { resultFormat: "objectArray", skipToken }
      };
      const pagedResponse = await withRetry(
        () => client.resources(pagedRequest)
      );
      const pageData = pagedResponse.data ?? [];
      allData.push(...pageData);
      skipToken = pagedResponse.skipToken;
      page++;
    }
    const result = {
      resources: allData,
      totalRecords
    };
    resourceGraphCache.set(cacheKey, {
      result,
      expiry: Date.now() + RESOURCE_GRAPH_CACHE_TTL_MS
    });
    return result;
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
async function getActivityLogs(subscriptionId, hoursBack = 24, resourceUri, resourceGroup, maxEvents = 1e3) {
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
      if (events.length >= maxEvents) {
        break;
      }
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
async function queryLogAnalytics(workspaceId, query, timespanHours = 24) {
  try {
    const client = createLogsQueryClient();
    const now = /* @__PURE__ */ new Date();
    const start = new Date(now.getTime() - timespanHours * 60 * 60 * 1e3);
    const timespan = { startTime: start, endTime: now };
    const result = await withRetry(
      () => client.queryWorkspace(workspaceId, query, timespan)
    );
    if (result.status === "PartialFailure") {
      const tables2 = result.partialTables.map((t) => ({
        name: t.name,
        columns: t.columnDescriptors.map((c) => c.name ?? ""),
        rows: t.rows ?? []
      }));
      return { tables: tables2 };
    }
    const tables = result.tables.map((t) => ({
      name: t.name,
      columns: t.columnDescriptors.map((c) => c.name ?? ""),
      rows: t.rows ?? []
    }));
    return { tables };
  } catch (err) {
    return { tables: [], error: classifyError(err, "logAnalytics") };
  }
}
async function discoverWorkspaces(subscriptionId, resourceGroup) {
  let query = "Resources | where type =~ 'Microsoft.OperationalInsights/workspaces' | project id, name, properties.customerId";
  if (resourceGroup) {
    query = `Resources | where type =~ 'Microsoft.OperationalInsights/workspaces' | where resourceGroup =~ '${resourceGroup}' | project id, name, properties.customerId`;
  }
  const result = await queryResourceGraph([subscriptionId], query);
  if (result.error) {
    return { workspaces: [], error: result.error };
  }
  const workspaces = result.resources.map((r) => ({
    workspaceId: r["properties_customerId"] ?? "",
    workspaceName: r["name"] ?? "",
    resourceId: r["id"] ?? ""
  }));
  return { workspaces };
}
async function batchExecute(tasks, batchSize = 5) {
  const results = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((fn) => fn()));
    results.push(...batchResults);
  }
  return results;
}

// src/tools/healthcheck.ts
function registerHealthcheck(server2) {
  server2.tool(
    "azdoctor_healthcheck",
    "Scan a subscription or resource group for health issues, anomalies, and risks. Returns a risk-scored summary of findings across all resources.",
    {
      subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z.string().optional().describe("Scope to a specific resource group"),
      severity: z.enum(["critical", "warning", "info"]).default("warning").describe("Minimum severity threshold for reported findings")
    },
    async ({ subscription: subParam, resourceGroup, severity }) => {
      const subscription = await resolveSubscription(subParam);
      const findings = [];
      const errors = [];
      const rgQuery = resourceGroup ? `Resources | where resourceGroup =~ '${resourceGroup}' | project id, name, type, location, resourceGroup` : `Resources | project id, name, type, location, resourceGroup`;
      const resourceList = await queryResourceGraph([subscription], rgQuery);
      if (resourceList.error) errors.push(resourceList.error);
      const scannedResources = resourceList.totalRecords;
      const [healthResult, activityResult, ...rgCheckResults] = await Promise.all([
        // Health check
        batchResourceHealth(subscription, resourceGroup),
        // Activity logs
        getActivityLogs(subscription, 24, void 0, resourceGroup),
        // Resource Graph checks for common misconfigurations
        queryResourceGraph(
          [subscription],
          resourceGroup ? `Resources | where resourceGroup =~ '${resourceGroup}' and type =~ 'Microsoft.Compute/disks' and properties.diskState == 'Unattached' | project id, name, type, location, resourceGroup` : `Resources | where type =~ 'Microsoft.Compute/disks' and properties.diskState == 'Unattached' | project id, name, type, location, resourceGroup`
        ),
        queryResourceGraph(
          [subscription],
          resourceGroup ? `Resources | where resourceGroup =~ '${resourceGroup}' and type =~ 'Microsoft.Network/publicIPAddresses' and (isnull(properties.ipConfiguration) or properties.ipConfiguration == '') | project id, name, type, location, resourceGroup` : `Resources | where type =~ 'Microsoft.Network/publicIPAddresses' and (isnull(properties.ipConfiguration) or properties.ipConfiguration == '') | project id, name, type, location, resourceGroup`
        ),
        queryResourceGraph(
          [subscription],
          resourceGroup ? `Resources | where resourceGroup =~ '${resourceGroup}' and (type startswith 'Microsoft.ClassicCompute' or type startswith 'Microsoft.ClassicNetwork' or type startswith 'Microsoft.ClassicStorage') | project id, name, type, location, resourceGroup` : `Resources | where type startswith 'Microsoft.ClassicCompute' or type startswith 'Microsoft.ClassicNetwork' or type startswith 'Microsoft.ClassicStorage' | project id, name, type, location, resourceGroup`
        ),
        queryResourceGraph(
          [subscription],
          resourceGroup ? `Resources | where resourceGroup =~ '${resourceGroup}' and (type =~ 'Microsoft.Sql/servers' or type =~ 'Microsoft.KeyVault/vaults' or type =~ 'Microsoft.DocumentDB/databaseAccounts') | project id, name, type, resourceGroup` : `Resources | where (type =~ 'Microsoft.Sql/servers' or type =~ 'Microsoft.KeyVault/vaults' or type =~ 'Microsoft.DocumentDB/databaseAccounts') | project id, name, type, resourceGroup`
        ),
        // Empty App Service Plans (paid plans with no apps)
        queryResourceGraph(
          [subscription],
          resourceGroup ? `Resources | where resourceGroup =~ '${resourceGroup}' and type =~ 'Microsoft.Web/serverfarms' and properties.numberOfSites == 0 and sku.tier != 'Free' and sku.tier != 'Shared' | project id, name, type, location, resourceGroup, sku` : `Resources | where type =~ 'Microsoft.Web/serverfarms' and properties.numberOfSites == 0 and sku.tier != 'Free' and sku.tier != 'Shared' | project id, name, type, location, resourceGroup, sku`
        )
      ]);
      const [unattachedDisksResult, unassociatedIPsResult, classicResourcesResult, criticalResourcesResult, emptyPlansResult] = rgCheckResults;
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
      let unattachedDiskCount = 0;
      if (unattachedDisksResult.error) {
        errors.push(unattachedDisksResult.error);
      } else {
        for (const disk of unattachedDisksResult.resources) {
          unattachedDiskCount++;
          findings.push({
            severity: "warning",
            resource: String(disk.name ?? "unknown"),
            resourceType: "Microsoft.Compute/disks",
            issue: `Unattached managed disk detected \u2014 incurring cost without being used.`,
            evidence: {
              id: disk.id,
              location: disk.location,
              resourceGroup: disk.resourceGroup
            },
            recommendation: "Delete the disk if no longer needed, or reattach it to a VM to avoid wasted cost."
          });
        }
      }
      let unassociatedIPCount = 0;
      if (unassociatedIPsResult.error) {
        errors.push(unassociatedIPsResult.error);
      } else {
        for (const ip of unassociatedIPsResult.resources) {
          unassociatedIPCount++;
          findings.push({
            severity: "warning",
            resource: String(ip.name ?? "unknown"),
            resourceType: "Microsoft.Network/publicIPAddresses",
            issue: `Public IP address is not associated with any resource \u2014 incurring cost with no use.`,
            evidence: {
              id: ip.id,
              location: ip.location,
              resourceGroup: ip.resourceGroup
            },
            recommendation: "Review whether this public IP is still needed. Unassociated public IPs may pose a security risk and incur cost."
          });
        }
      }
      let classicResourceCount = 0;
      if (classicResourcesResult.error) {
        errors.push(classicResourcesResult.error);
      } else {
        for (const res of classicResourcesResult.resources) {
          classicResourceCount++;
          findings.push({
            severity: "warning",
            resource: String(res.name ?? "unknown"),
            resourceType: String(res.type ?? "Microsoft.Classic*"),
            issue: `Classic (ASM) resource detected \u2014 this deployment model is deprecated.`,
            evidence: {
              id: res.id,
              type: res.type,
              location: res.location,
              resourceGroup: res.resourceGroup
            },
            recommendation: "Migrate to Azure Resource Manager (ARM). Classic resources will be retired. See https://aka.ms/classicresourcemigration."
          });
        }
      }
      if (criticalResourcesResult.error) {
        errors.push(criticalResourcesResult.error);
      } else {
        for (const res of criticalResourcesResult.resources) {
          findings.push({
            severity: "info",
            resource: String(res.name ?? "unknown"),
            resourceType: String(res.type ?? "unknown"),
            issue: `Critical resource type detected \u2014 review whether resource locks are configured.`,
            evidence: {
              id: res.id,
              type: res.type,
              resourceGroup: res.resourceGroup
            },
            recommendation: "Consider adding a CanNotDelete or ReadOnly lock to protect this critical resource from accidental deletion or modification."
          });
        }
      }
      let emptyPlanCount = 0;
      if (emptyPlansResult.error) {
        errors.push(emptyPlansResult.error);
      } else {
        for (const plan of emptyPlansResult.resources) {
          emptyPlanCount++;
          findings.push({
            severity: "warning",
            resource: String(plan.name ?? "unknown"),
            resourceType: "Microsoft.Web/serverfarms",
            issue: `Paid App Service Plan with no apps deployed \u2014 incurring cost with no workload.`,
            evidence: {
              id: plan.id,
              location: plan.location,
              resourceGroup: plan.resourceGroup,
              sku: plan.sku
            },
            recommendation: "Delete the empty plan if no longer needed, or deploy an app to it."
          });
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
        criticalCount * 30 + warningCount * 10 + infoCount * 2 + unattachedDiskCount * 3 + classicResourceCount * 5 + unassociatedIPCount * 3 + emptyPlanCount * 3
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
var SEVERITY_RANK = {
  critical: 3,
  warning: 2,
  info: 1
};
function clusterEvents(events, windowMinutes = 5) {
  if (events.length === 0) return [];
  const sorted = [...events].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );
  const windowMs = windowMinutes * 60 * 1e3;
  const clusters = [];
  let currentCluster = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const lastInCluster = currentCluster[currentCluster.length - 1];
    const gap = new Date(sorted[i].time).getTime() - new Date(lastInCluster.time).getTime();
    if (gap <= windowMs) {
      currentCluster.push(sorted[i]);
    } else {
      clusters.push(buildCluster(currentCluster));
      currentCluster = [sorted[i]];
    }
  }
  clusters.push(buildCluster(currentCluster));
  return clusters;
}
function buildCluster(events) {
  const sources = [...new Set(events.map((e) => e.source))];
  const highestSeverity = events.reduce(
    (max, e) => {
      const rank = SEVERITY_RANK[e.severity ?? "info"] ?? 1;
      return rank > (SEVERITY_RANK[max] ?? 1) ? e.severity : max;
    },
    "info"
  );
  return {
    startTime: events[0].time,
    endTime: events[events.length - 1].time,
    events,
    sources,
    severity: highestSeverity
  };
}
function correlateTimelines(events, windowMinutes = 15) {
  if (events.length === 0) {
    return {
      timeline: [],
      earliestAnomaly: null,
      precedingChanges: [],
      likelyCause: "No diagnostic events were collected \u2014 insufficient data for correlation.",
      confidence: "low",
      cascadingFailure: false
    };
  }
  const sorted = [...events].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );
  const anomalies = sorted.filter((e) => ANOMALY_SOURCES.has(e.source));
  const changes = sorted.filter((e) => CHANGE_SOURCES.has(e.source));
  const anomalyClusters = clusterEvents(anomalies, 5);
  const cascadingFailure = anomalyClusters.some(
    (cluster) => cluster.events.length >= 3
  );
  const earliestAnomaly = anomalies.length > 0 ? anomalies[0] : null;
  if (!earliestAnomaly) {
    const confidence2 = changes.length > 0 ? "medium" : "low";
    if (changes.length > 0) {
      return {
        timeline: sorted,
        earliestAnomaly: null,
        precedingChanges: changes,
        likelyCause: `${changes.length} change(s) detected but no anomalies observed. Resources may be healthy, or monitoring data may be incomplete.`,
        confidence: confidence2,
        cascadingFailure: false
      };
    }
    return {
      timeline: sorted,
      earliestAnomaly: null,
      precedingChanges: [],
      likelyCause: "No anomalies or changes detected in the investigation window.",
      confidence: confidence2,
      cascadingFailure: false
    };
  }
  const anomalyTime = new Date(earliestAnomaly.time).getTime();
  const windowMs = windowMinutes * 60 * 1e3;
  const precedingChanges = changes.filter((c) => {
    const changeTime = new Date(c.time).getTime();
    return changeTime <= anomalyTime && anomalyTime - changeTime <= windowMs;
  });
  const hasAnomalies = anomalies.length > 0;
  const hasPrecedingChanges = precedingChanges.length > 0;
  let confidence;
  if (hasPrecedingChanges && hasAnomalies) {
    confidence = "high";
  } else if (hasAnomalies || hasPrecedingChanges) {
    confidence = "medium";
  } else {
    confidence = "low";
  }
  const likelyCause = buildCausalNarrative(
    earliestAnomaly,
    precedingChanges,
    anomalies,
    windowMinutes,
    cascadingFailure
  );
  return {
    timeline: sorted,
    earliestAnomaly,
    precedingChanges,
    likelyCause,
    confidence,
    cascadingFailure
  };
}
function buildCausalNarrative(earliestAnomaly, precedingChanges, allAnomalies, windowMinutes, cascadingFailure) {
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
  if (cascadingFailure) {
    parts.push(
      "Cascading failure pattern detected: 3+ anomalies clustered within 5 minutes, suggesting a chain reaction across resources."
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
function detectDiagnosticPatterns(events, resourceType) {
  const insights = [];
  const normalizedType = resourceType.toLowerCase();
  const findEvents = (substring) => events.filter((e) => e.event.toLowerCase().includes(substring.toLowerCase()));
  const findEventsBySeverity = (substring, ...severities) => events.filter(
    (e) => e.event.toLowerCase().includes(substring.toLowerCase()) && severities.includes(e.severity ?? "info")
  );
  const findEventsBySource = (source) => events.filter((e) => e.source === source);
  const withinMinutes = (a, b, minutes) => {
    const diff = Math.abs(
      new Date(a.time).getTime() - new Date(b.time).getTime()
    );
    return diff <= minutes * 60 * 1e3;
  };
  const anyWithinMinutes = (groupA, groupB, minutes) => {
    for (const a of groupA) {
      for (const b of groupB) {
        if (withinMinutes(a, b, minutes)) return true;
      }
    }
    return false;
  };
  if (normalizedType === "microsoft.web/sites") {
    const deployments = findEventsBySource("ActivityLog").filter(
      (e) => e.event.toLowerCase().includes("deploy") || e.event.toLowerCase().includes("restart") || e.event.toLowerCase().includes("swap") || e.event.toLowerCase().includes("write")
    );
    const http5xx = findEvents("Http5xx");
    const httpResponseTime = findEvents("HttpResponseTime");
    const errorSignals = [...http5xx, ...httpResponseTime];
    if (deployments.length > 0 && errorSignals.length > 0 && anyWithinMinutes(deployments, errorSignals, 15)) {
      insights.push({
        pattern: "bad_deployment",
        description: "A deployment or configuration change occurred shortly before HTTP errors or response time degradation.",
        confidence: "high",
        evidence: [
          ...deployments.map((e) => `[ActivityLog] ${e.event} at ${e.time}`),
          ...errorSignals.map((e) => `[Metrics] ${e.event} at ${e.time}`)
        ],
        recommendation: "Recent deployment likely caused errors. Consider rolling back."
      });
    }
    const memoryCritical = findEventsBySeverity(
      "MemoryPercentage",
      "critical"
    );
    const httpQueue = findEvents("HttpQueueLength");
    const httpRespWarnCrit = findEventsBySeverity(
      "HttpResponseTime",
      "warning",
      "critical"
    );
    const queueOrResp = [...httpQueue, ...httpRespWarnCrit];
    if (memoryCritical.length > 0 && queueOrResp.length > 0) {
      insights.push({
        pattern: "memory_exhaustion",
        description: "High memory usage is causing request queuing and response time degradation.",
        confidence: "high",
        evidence: [
          ...memoryCritical.map((e) => `[Metrics] ${e.event} at ${e.time}`),
          ...queueOrResp.map((e) => `[Metrics] ${e.event} at ${e.time}`)
        ],
        recommendation: "Memory pressure causing request queuing. Scale up the App Service Plan or optimize memory usage."
      });
    }
    const cpuCritical = findEventsBySeverity("CpuPercentage", "critical");
    if (cpuCritical.length > 0 && httpRespWarnCrit.length > 0) {
      insights.push({
        pattern: "cpu_saturation",
        description: "High CPU usage is degrading HTTP response times.",
        confidence: "high",
        evidence: [
          ...cpuCritical.map((e) => `[Metrics] ${e.event} at ${e.time}`),
          ...httpRespWarnCrit.map((e) => `[Metrics] ${e.event} at ${e.time}`)
        ],
        recommendation: "CPU saturation degrading response times. Scale out or optimize CPU-intensive operations."
      });
    }
    const healthCheck = findEvents("HealthCheckStatus");
    if (healthCheck.length > 0) {
      insights.push({
        pattern: "health_check_failure",
        description: "The health check endpoint is reporting failures.",
        confidence: "medium",
        evidence: healthCheck.map(
          (e) => `[Metrics] ${e.event} at ${e.time}`
        ),
        recommendation: "Health check endpoint is failing. Review the health check path configuration and application startup."
      });
    }
  }
  if (normalizedType === "microsoft.sql/servers/databases") {
    const dtuCritical = findEventsBySeverity(
      "dtu_consumption_percent",
      "critical"
    );
    if (dtuCritical.length > 0) {
      insights.push({
        pattern: "dtu_exhaustion",
        description: "Database DTU consumption has reached critical levels.",
        confidence: "high",
        evidence: dtuCritical.map(
          (e) => `[Metrics] ${e.event} at ${e.time}`
        ),
        recommendation: "DTU capacity exhausted. Scale up the database tier or optimize queries."
      });
    }
    const connFailed = findEventsBySeverity(
      "connection_failed",
      "warning",
      "critical"
    );
    if (connFailed.length > 0) {
      insights.push({
        pattern: "connection_storm",
        description: "Database connection failures are occurring.",
        confidence: "high",
        evidence: connFailed.map(
          (e) => `[Metrics] ${e.event} at ${e.time}`
        ),
        recommendation: "Connection failures detected. Check connection pool settings and max connection limits."
      });
    }
    const deadlocks = findEventsBySeverity("deadlock", "warning", "critical");
    const dtuWarning = findEventsBySeverity(
      "dtu_consumption_percent",
      "warning"
    );
    if (deadlocks.length > 0 && dtuWarning.length > 0) {
      insights.push({
        pattern: "deadlock_storm",
        description: "Deadlocks are occurring alongside elevated DTU consumption.",
        confidence: "high",
        evidence: [
          ...deadlocks.map((e) => `[Metrics] ${e.event} at ${e.time}`),
          ...dtuWarning.map((e) => `[Metrics] ${e.event} at ${e.time}`)
        ],
        recommendation: "Deadlocks under load. Review transaction isolation levels and query patterns."
      });
    }
  }
  if (normalizedType === "microsoft.compute/virtualmachines") {
    const diskQueue = findEventsBySeverity(
      "OS Disk Queue Depth",
      "critical"
    );
    if (diskQueue.length > 0) {
      insights.push({
        pattern: "disk_bottleneck",
        description: "OS disk I/O queue depth has reached critical levels.",
        confidence: "high",
        evidence: diskQueue.map(
          (e) => `[Metrics] ${e.event} at ${e.time}`
        ),
        recommendation: "Disk I/O bottleneck. Consider Premium SSD or Ultra Disk, or distribute I/O across multiple disks."
      });
    }
    const networkIn = findEventsBySeverity("Network In", "critical");
    const networkOut = findEventsBySeverity("Network Out", "critical");
    const networkEvents = [...networkIn, ...networkOut];
    if (networkEvents.length > 0) {
      insights.push({
        pattern: "network_saturation",
        description: "Network bandwidth has reached critical levels.",
        confidence: "high",
        evidence: networkEvents.map(
          (e) => `[Metrics] ${e.event} at ${e.time}`
        ),
        recommendation: "Network bandwidth saturated. Consider accelerated networking or scaling to a larger VM size."
      });
    }
  }
  const healthUnavailable = events.filter(
    (e) => e.source === "ResourceHealth" && e.event.toLowerCase().includes("unavailable")
  );
  const activityLogEvents = findEventsBySource("ActivityLog");
  if (healthUnavailable.length > 0) {
    const hasPrecedingChange = healthUnavailable.some((h) => {
      const hTime = new Date(h.time).getTime();
      return activityLogEvents.some((a) => {
        const aTime = new Date(a.time).getTime();
        return aTime < hTime && hTime - aTime <= 15 * 60 * 1e3;
      });
    });
    if (!hasPrecedingChange) {
      insights.push({
        pattern: "platform_incident",
        description: "Resource became unavailable with no preceding configuration changes.",
        confidence: "medium",
        evidence: healthUnavailable.map(
          (e) => `[ResourceHealth] ${e.event} at ${e.time}`
        ),
        recommendation: "Platform-level incident suspected. Check Azure Service Health."
      });
    }
  }
  if (activityLogEvents.length >= 5) {
    const sorted = [...activityLogEvents].sort(
      (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
    );
    const tenMinMs = 10 * 60 * 1e3;
    let found = false;
    for (let i = 0; i <= sorted.length - 5 && !found; i++) {
      const startTime = new Date(sorted[i].time).getTime();
      const endTime = new Date(sorted[i + 4].time).getTime();
      if (endTime - startTime <= tenMinMs) {
        found = true;
        insights.push({
          pattern: "rapid_config_changes",
          description: "Multiple configuration changes occurred in a short time window.",
          confidence: "medium",
          evidence: sorted.map(
            (e) => `[ActivityLog] ${e.event} at ${e.time}`
          ),
          recommendation: "Rapid configuration changes detected. This may indicate automated remediation loops or deployment issues."
        });
      }
    }
  }
  const confidenceOrder = {
    high: 0,
    medium: 1,
    low: 2
  };
  insights.sort(
    (a, b) => (confidenceOrder[a.confidence] ?? 2) - (confidenceOrder[b.confidence] ?? 2)
  );
  return insights;
}
function detectTrends(dataPoints, metricName) {
  const values = [];
  for (const dp of dataPoints) {
    const v = dp.average ?? dp.maximum;
    if (v !== void 0) {
      values.push(v);
    }
  }
  const n = values.length;
  if (n < 2) {
    return {
      metricName,
      trend: "stable",
      slope: 0,
      dataPoints: n,
      description: `${metricName} has insufficient data points for trend analysis.`
    };
  }
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denominator = n * sumX2 - sumX * sumX;
  const rawSlope = denominator !== 0 ? (n * sumXY - sumX * sumY) / denominator : 0;
  const intercept = (sumY - rawSlope * sumX) / n;
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const dataRange = maxVal - minVal;
  let normalizedSlope;
  if (dataRange === 0) {
    normalizedSlope = 0;
  } else {
    const totalChange = rawSlope * (n - 1);
    normalizedSlope = Math.max(-1, Math.min(1, totalChange / dataRange));
  }
  const meanY = sumY / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + rawSlope * i;
    ssRes += (values[i] - predicted) ** 2;
    ssTot += (values[i] - meanY) ** 2;
  }
  const rSquared = ssTot !== 0 ? 1 - ssRes / ssTot : 1;
  let trend;
  if (Math.abs(normalizedSlope) < 0.1) {
    trend = "stable";
  } else if (rSquared < 0.3) {
    trend = "volatile";
  } else if (normalizedSlope > 0) {
    trend = "rising";
  } else {
    trend = "falling";
  }
  let description;
  switch (trend) {
    case "rising":
      description = `${metricName} is rising steadily over the observed period.`;
      break;
    case "falling":
      description = `${metricName} is falling steadily over the observed period.`;
      break;
    case "stable":
      description = `${metricName} is stable over the observed period.`;
      break;
    case "volatile":
      description = `${metricName} is volatile with no clear trend over the observed period.`;
      break;
  }
  return {
    metricName,
    trend,
    slope: Math.round(normalizedSlope * 1e3) / 1e3,
    // round to 3 decimal places
    dataPoints: n,
    description
  };
}

// src/utils/metric-config.ts
var TYPE_SHORTCUTS = {
  VM: "microsoft.compute/virtualmachines",
  SQL: "microsoft.sql/servers/databases",
  APPSERVICE: "microsoft.web/sites",
  APPPLAN: "microsoft.web/serverfarms",
  REDIS: "microsoft.cache/redis",
  COSMOS: "microsoft.documentdb/databaseaccounts",
  AKS: "microsoft.containerservice/managedclusters",
  STORAGE: "microsoft.storage/storageaccounts",
  KEYVAULT: "microsoft.keyvault/vaults",
  APIM: "microsoft.apimanagement/service",
  SERVICEBUS: "microsoft.servicebus/namespaces",
  EVENTHUB: "microsoft.eventhub/namespaces",
  POSTGRES: "microsoft.dbforpostgresql/flexibleservers",
  MYSQL: "microsoft.dbformysql/flexibleservers",
  APPGW: "microsoft.network/applicationgateways",
  LB: "microsoft.network/loadbalancers",
  FIREWALL: "microsoft.network/azurefirewalls",
  CDN: "microsoft.cdn/profiles",
  COGNITIVE: "microsoft.cognitiveservices/accounts",
  SIGNALR: "microsoft.signalrservice/signalr"
};
function loadThresholdOverrides() {
  const overrides = { perType: {} };
  const globalWarn = process.env.AZDOCTOR_THRESHOLD_WARNING;
  if (globalWarn) overrides.globalWarning = parseInt(globalWarn, 10);
  const globalCrit = process.env.AZDOCTOR_THRESHOLD_CRITICAL;
  if (globalCrit) overrides.globalCritical = parseInt(globalCrit, 10);
  for (const [shortcut, fullType] of Object.entries(TYPE_SHORTCUTS)) {
    const warn = process.env[`AZDOCTOR_THRESHOLD_${shortcut}_WARNING`];
    const crit = process.env[`AZDOCTOR_THRESHOLD_${shortcut}_CRITICAL`];
    if (warn || crit) {
      overrides.perType[fullType] = {
        warning: warn ? parseInt(warn, 10) : void 0,
        critical: crit ? parseInt(crit, 10) : void 0
      };
    }
  }
  return overrides;
}
var thresholdOverrides = loadThresholdOverrides();
var METRIC_MAP = {
  // Compute
  "microsoft.web/sites": {
    names: ["Http5xx", "Http4xx", "HttpResponseTime", "CpuPercentage", "MemoryPercentage", "HealthCheckStatus"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.web/serverfarms": {
    names: ["CpuPercentage", "MemoryPercentage", "DiskQueueLength", "HttpQueueLength"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.compute/virtualmachines": {
    names: ["Percentage CPU", "Available Memory Bytes", "OS Disk Queue Depth", "Network In Total", "Network Out Total"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.containerservice/managedclusters": {
    names: ["node_cpu_usage_percentage", "node_memory_rss_percentage", "kube_pod_status_ready"],
    warningPct: 80,
    criticalPct: 90
  },
  // Databases
  "microsoft.sql/servers/databases": {
    names: ["dtu_consumption_percent", "connection_failed", "deadlock", "storage_percent", "workers_percent"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.documentdb/databaseaccounts": {
    names: ["TotalRequestUnits", "NormalizedRUConsumption", "TotalRequests", "Http429"],
    warningPct: 80,
    criticalPct: 95
  },
  "microsoft.dbformysql/flexibleservers": {
    names: ["cpu_percent", "memory_percent", "io_consumption_percent", "active_connections", "storage_percent"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.dbforpostgresql/flexibleservers": {
    names: ["cpu_percent", "memory_percent", "storage_percent", "active_connections"],
    warningPct: 80,
    criticalPct: 90
  },
  // Caching
  "microsoft.cache/redis": {
    names: ["percentProcessorTime", "usedmemorypercentage", "serverLoad", "cacheRead", "cacheWrite", "connectedclients"],
    warningPct: 80,
    criticalPct: 90
  },
  // Storage
  "microsoft.storage/storageaccounts": {
    names: ["Availability", "SuccessE2ELatency", "SuccessServerLatency", "Transactions"],
    warningPct: 80,
    criticalPct: 90
  },
  // Networking
  "microsoft.network/applicationgateways": {
    names: ["TotalRequests", "FailedRequests", "ResponseStatus", "HealthyHostCount", "UnhealthyHostCount", "BackendResponseStatus"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.network/loadbalancers": {
    names: ["SnatConnectionCount", "AllocatedSnatPorts", "UsedSnatPorts", "DipAvailability", "VipAvailability"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.network/azurefirewalls": {
    names: ["Throughput", "ApplicationRuleHit", "NetworkRuleHit", "FirewallHealth"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.cdn/profiles": {
    names: ["RequestCount", "ByteHitRatio", "OriginHealthPercentage", "TotalLatency"],
    warningPct: 80,
    criticalPct: 90
  },
  // Messaging
  "microsoft.servicebus/namespaces": {
    names: ["IncomingRequests", "ServerErrors", "ThrottledRequests", "ActiveMessages", "DeadletteredMessages"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.eventhub/namespaces": {
    names: ["IncomingRequests", "ServerErrors", "ThrottledRequests", "OutgoingMessages", "IncomingBytes"],
    warningPct: 80,
    criticalPct: 90
  },
  // AI & API
  "microsoft.cognitiveservices/accounts": {
    names: ["TotalCalls", "TotalErrors", "Latency", "SuccessRate"],
    warningPct: 80,
    criticalPct: 90
  },
  "microsoft.apimanagement/service": {
    names: ["TotalRequests", "FailedRequests", "UnauthorizedRequests", "BackendDuration", "Capacity"],
    warningPct: 80,
    criticalPct: 90
  },
  // Security
  "microsoft.keyvault/vaults": {
    names: ["ServiceApiHit", "ServiceApiLatency", "Availability", "SaturationShoebox"],
    warningPct: 80,
    criticalPct: 90
  },
  // SignalR
  "microsoft.signalrservice/signalr": {
    names: ["ConnectionCount", "MessageCount", "ServerLoad", "ConnectionCloseCount"],
    warningPct: 80,
    criticalPct: 90
  }
};
var DEPENDENCY_MAP = {
  "microsoft.web/sites": [
    {
      description: "Databases (SQL, MySQL, PostgreSQL, Cosmos DB)",
      query: "Resources | where resourceGroup =~ '{rg}' and (type =~ 'Microsoft.Sql/servers/databases' or type =~ 'Microsoft.DocumentDB/databaseAccounts' or type =~ 'Microsoft.DBforMySQL/flexibleServers' or type =~ 'Microsoft.DBforPostgreSQL/flexibleServers') | project id, name, type"
    },
    {
      description: "Caches (Redis)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Cache/Redis' | project id, name, type"
    },
    {
      description: "Storage accounts",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Storage/storageAccounts' | project id, name, type"
    },
    {
      description: "Key Vaults",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.KeyVault/vaults' | project id, name, type"
    },
    {
      description: "Service Bus / Event Hub",
      query: "Resources | where resourceGroup =~ '{rg}' and (type =~ 'Microsoft.ServiceBus/namespaces' or type =~ 'Microsoft.EventHub/namespaces') | project id, name, type"
    },
    {
      description: "App Service Plan (hosting plan)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/serverfarms' | project id, name, type"
    }
  ],
  "microsoft.compute/virtualmachines": [
    {
      description: "Disks",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Compute/disks' | project id, name, type"
    },
    {
      description: "Network interfaces",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Network/networkInterfaces' | project id, name, type"
    },
    {
      description: "Network security groups",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Network/networkSecurityGroups' | project id, name, type"
    }
  ],
  "microsoft.containerservice/managedclusters": [
    {
      description: "Container registries",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.ContainerRegistry/registries' | project id, name, type"
    },
    {
      description: "Key Vaults",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.KeyVault/vaults' | project id, name, type"
    },
    {
      description: "Storage accounts",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Storage/storageAccounts' | project id, name, type"
    }
  ],
  "microsoft.network/applicationgateways": [
    {
      description: "Backend App Services",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type"
    },
    {
      description: "Backend VMs",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Compute/virtualMachines' | project id, name, type"
    }
  ],
  "microsoft.apimanagement/service": [
    {
      description: "Backend App Services",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type"
    },
    {
      description: "Backend Functions",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' and kind contains 'functionapp' | project id, name, type"
    }
  ],
  "microsoft.sql/servers/databases": [
    {
      description: "Dependent App Services",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type"
    }
  ],
  "microsoft.web/serverfarms": [
    {
      description: "App Services on this plan",
      query: "Resources | where type =~ 'Microsoft.Web/sites' and resourceGroup =~ '{rg}' | project id, name, type"
    }
  ],
  "microsoft.cache/redis": [
    {
      description: "App Services (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type"
    }
  ],
  "microsoft.keyvault/vaults": [
    {
      description: "App Services (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type"
    },
    {
      description: "VMs (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Compute/virtualMachines' | project id, name, type"
    }
  ],
  "microsoft.network/loadbalancers": [
    {
      description: "Backend VMs",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Compute/virtualMachines' | project id, name, type"
    }
  ],
  "microsoft.servicebus/namespaces": [
    {
      description: "App Services (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type"
    },
    {
      description: "Functions (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' and kind contains 'functionapp' | project id, name, type"
    }
  ],
  "microsoft.eventhub/namespaces": [
    {
      description: "App Services (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type"
    }
  ]
};
function getMetricConfig(resourceType) {
  const base = METRIC_MAP[resourceType.toLowerCase()];
  if (!base) return void 0;
  const typeOverride = thresholdOverrides.perType[resourceType.toLowerCase()];
  return {
    names: base.names,
    warningPct: typeOverride?.warning ?? thresholdOverrides.globalWarning ?? base.warningPct,
    criticalPct: typeOverride?.critical ?? thresholdOverrides.globalCritical ?? base.criticalPct
  };
}
function getDependencyQueries(resourceType, resourceGroup) {
  const queries = DEPENDENCY_MAP[resourceType.toLowerCase()];
  if (!queries) return [];
  return queries.map((q) => ({
    ...q,
    query: q.query.replace(/\{rg\}/g, resourceGroup)
  }));
}

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
function formatErrorSummary(errors) {
  const permissionGaps = [];
  const otherErrors = [];
  for (const err of errors) {
    if (err.code === "FORBIDDEN") {
      permissionGaps.push({
        api: err.message,
        recommendation: err.roleRecommendation ?? "Check required RBAC roles"
      });
    } else {
      otherErrors.push({ api: err.code, message: err.message });
    }
  }
  let message;
  if (errors.length === 0) {
    message = "All APIs accessible \u2014 full diagnostic data available.";
  } else if (otherErrors.length === 0) {
    message = `${permissionGaps.length} API(s) inaccessible due to permissions \u2014 results may be incomplete. Run azdoctor_check_permissions for details.`;
  } else if (permissionGaps.length === 0) {
    message = `${otherErrors.length} API call(s) failed \u2014 some diagnostic data may be missing.`;
  } else {
    message = `${permissionGaps.length} API(s) inaccessible due to permissions \u2014 results may be incomplete. Run azdoctor_check_permissions for details. ${otherErrors.length} API call(s) failed \u2014 some diagnostic data may be missing.`;
  }
  return {
    totalErrors: errors.length,
    permissionGaps,
    otherErrors,
    message
  };
}
function healthTag(health) {
  switch (health) {
    case "Available":
      return "[OK]";
    case "Degraded":
      return "[WARN]";
    case "Unavailable":
      return "[CRIT]";
    case "Unknown":
      return "[??]";
  }
}
function renderTopology(root, dependencies) {
  const rootLabel = `${root.name} (${root.type})`;
  const rootTag = healthTag(root.health);
  const rootContent = `  ${rootLabel}  ${rootTag}  `;
  const rootBoxWidth = Math.min(70, Math.max(30, rootContent.length + 2));
  const paddedRootContent = rootContent.padEnd(rootBoxWidth - 2);
  const rootTop = `\u250C${"\u2500".repeat(rootBoxWidth - 2)}\u2510`;
  const rootMid = `\u2502${paddedRootContent}\u2502`;
  const rootBot = dependencies.length > 0 ? (() => {
    const half = Math.floor((rootBoxWidth - 2) / 2);
    return `\u2514${"\u2500".repeat(half)}\u252C${"\u2500".repeat(rootBoxWidth - 3 - half)}\u2518`;
  })() : `\u2514${"\u2500".repeat(rootBoxWidth - 2)}\u2518`;
  if (dependencies.length === 0) {
    return [rootTop, rootMid, rootBot].join("\n");
  }
  const connectorPos = Math.floor((rootBoxWidth - 2) / 2) + 1;
  if (dependencies.length > 4) {
    const lines = [rootTop, rootMid, rootBot];
    const pad = " ".repeat(connectorPos);
    lines.push(`${pad}\u2502`);
    for (let i = 0; i < dependencies.length; i++) {
      const dep = dependencies[i];
      const connector = i < dependencies.length - 1 ? "\u251C" : "\u2514";
      const depLabel = `${dep.name} (${dep.type}) ${healthTag(dep.health)}`;
      lines.push(`${pad}${connector}\u2500\u2500 ${depLabel}`);
    }
    return lines.join("\n");
  }
  const depBoxes = [];
  for (const dep of dependencies) {
    const name = dep.name;
    const tag = healthTag(dep.health);
    const line1Width = name.length;
    const line2Width = tag.length;
    const innerWidth = Math.max(line1Width, line2Width) + 2;
    const padName = name.padStart(Math.floor((innerWidth + name.length) / 2)).padEnd(innerWidth);
    const padTag = tag.padStart(Math.floor((innerWidth + tag.length) / 2)).padEnd(innerWidth);
    depBoxes.push({
      top: `\u250C${"\u2500".repeat(innerWidth)}\u2510`,
      mid1: `\u2502${padName}\u2502`,
      mid2: `\u2502${padTag}\u2502`,
      bot: `\u2514${"\u2500".repeat(innerWidth)}\u2518`,
      width: innerWidth + 2
      // include borders
    });
  }
  const gap = " ";
  const totalWidth = depBoxes.reduce((s, b) => s + b.width, 0) + (depBoxes.length - 1) * gap.length;
  const boxCenters = [];
  let offset = 0;
  for (const box of depBoxes) {
    boxCenters.push(offset + Math.floor(box.width / 2));
    offset += box.width + gap.length;
  }
  const depRowOffset = Math.max(0, connectorPos - Math.floor(totalWidth / 2));
  const adjustedCenters = boxCenters.map((c) => c + depRowOffset);
  const vertLine = " ".repeat(connectorPos) + "\u2502";
  const leftmost = adjustedCenters[0];
  const rightmost = adjustedCenters[adjustedCenters.length - 1];
  const branchWidth = rightmost - leftmost + 1;
  const branchChars = new Array(rightmost + 1).fill(" ");
  for (let i = leftmost; i <= rightmost; i++) {
    branchChars[i] = "\u2500";
  }
  for (const c of adjustedCenters) {
    branchChars[c] = "\u253C";
  }
  if (connectorPos >= leftmost && connectorPos <= rightmost) {
    branchChars[connectorPos] = "\u253C";
  }
  const branchLine = branchChars.join("");
  const arrowChars = new Array(rightmost + 1).fill(" ");
  for (const c of adjustedCenters) {
    arrowChars[c] = "\u25BC";
  }
  const arrowLine = arrowChars.join("");
  const padLeft = " ".repeat(depRowOffset);
  const boxTop = padLeft + depBoxes.map((b) => b.top).join(gap);
  const boxMid1 = padLeft + depBoxes.map((b) => b.mid1).join(gap);
  const boxMid2 = padLeft + depBoxes.map((b) => b.mid2).join(gap);
  const boxBot = padLeft + depBoxes.map((b) => b.bot).join(gap);
  return [
    rootTop,
    rootMid,
    rootBot,
    vertLine,
    branchLine,
    arrowLine,
    boxTop,
    boxMid1,
    boxMid2,
    boxBot
  ].join("\n");
}
function healthColor(health) {
  switch (health) {
    case "Available":
      return "fill:#d4edda,stroke:#28a745";
    case "Degraded":
      return "fill:#fff3cd,stroke:#ffc107";
    case "Unavailable":
      return "fill:#f8d7da,stroke:#dc3545";
    case "Unknown":
      return "fill:#e2e3e5,stroke:#6c757d";
  }
}
function healthIcon(health) {
  switch (health) {
    case "Available":
      return "\u2705";
    case "Degraded":
      return "\u26A0\uFE0F";
    case "Unavailable":
      return "\u274C";
    case "Unknown":
      return "\u2753";
  }
}
function renderMermaidTopology(root, dependencies) {
  const lines = [];
  lines.push("```mermaid");
  lines.push("graph TD");
  lines.push(`    root["${root.name}<br/><i>${root.type}</i><br/>${healthIcon(root.health)} ${root.health}"]`);
  for (let i = 0; i < dependencies.length; i++) {
    const dep = dependencies[i];
    lines.push(`    dep${i}["${dep.name}<br/><i>${dep.type}</i><br/>${healthIcon(dep.health)} ${dep.health}"]`);
  }
  for (let i = 0; i < dependencies.length; i++) {
    lines.push(`    root --> dep${i}`);
  }
  lines.push(`    style root ${healthColor(root.health)}`);
  for (let i = 0; i < dependencies.length; i++) {
    lines.push(`    style dep${i} ${healthColor(dependencies[i].health)}`);
  }
  lines.push("```");
  return lines.join("\n");
}
function sanitizeMermaidText(text) {
  let sanitized = text.replace(/["\[\]|{}()<>]/g, "");
  if (sanitized.length > 60) {
    sanitized = sanitized.substring(0, 57) + "...";
  }
  return sanitized.trim();
}
function renderMermaidTimeline(events) {
  if (events.length === 0) {
    return `\`\`\`mermaid
timeline
    title Incident Timeline
    section No Data
        -- : No events recorded
\`\`\``;
  }
  const sorted = [...events].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );
  const firstAlertIdx = sorted.findIndex(
    (e) => e.severity === "critical" || e.severity === "warning"
  );
  let lastAlertIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].severity === "critical" || sorted[i].severity === "warning") {
      lastAlertIdx = i;
      break;
    }
  }
  const preIncident = [];
  const incident = [];
  const resolution = [];
  for (let i = 0; i < sorted.length; i++) {
    if (firstAlertIdx === -1) {
      preIncident.push(sorted[i]);
    } else if (i < firstAlertIdx) {
      preIncident.push(sorted[i]);
    } else if (lastAlertIdx !== -1 && i > lastAlertIdx) {
      resolution.push(sorted[i]);
    } else {
      incident.push(sorted[i]);
    }
  }
  const lines = [];
  lines.push("```mermaid");
  lines.push("timeline");
  lines.push("    title Incident Timeline");
  const formatTime = (iso) => {
    const d = new Date(iso);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };
  const renderEvent = (e) => {
    const time = formatTime(e.time);
    const text = sanitizeMermaidText(e.event);
    const severity = e.severity ? ` (${e.severity})` : "";
    return `        ${time} : ${text}${severity}`;
  };
  if (preIncident.length > 0) {
    lines.push("    section Pre-Incident");
    for (const e of preIncident) {
      lines.push(renderEvent(e));
    }
  }
  if (incident.length > 0) {
    lines.push("    section Incident");
    for (const e of incident) {
      lines.push(renderEvent(e));
    }
  }
  if (resolution.length > 0) {
    lines.push("    section Resolution");
    for (const e of resolution) {
      lines.push(renderEvent(e));
    }
  }
  lines.push("```");
  return lines.join("\n");
}

// src/tools/investigate.ts
function registerInvestigate(server2) {
  server2.tool(
    "azdoctor_investigate",
    "Investigate a specific Azure resource or incident. Performs multi-signal correlation across Resource Health, Activity Logs, Metrics, and dependent resources to identify root cause.",
    {
      resource: z2.string().describe("Resource name or full Azure resource ID"),
      subscription: z2.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z2.string().optional().describe("Resource group name (helps resolve resource ID faster)"),
      timeframeHours: z2.number().default(24).describe("How many hours back to investigate"),
      symptom: z2.string().optional().describe(
        'User-described symptom (e.g., "slow", "500 errors", "unreachable")'
      )
    },
    async ({
      resource,
      subscription: subParam,
      resourceGroup,
      timeframeHours,
      symptom
    }) => {
      const subscription = await resolveSubscription(subParam);
      const errors = [];
      const allEvents = [];
      let resourceId = resource;
      let resourceType = "Unknown";
      let resourceName = resource;
      let resolvedResourceGroup = resourceGroup;
      if (!resource.startsWith("/subscriptions/")) {
        const rgFilter = resourceGroup ? `| where resourceGroup =~ '${resourceGroup}'` : "";
        const resolveQuery = `Resources | where name =~ '${resource}' ${rgFilter} | project id, name, type, location, resourceGroup | take 1`;
        const resolved = await queryResourceGraph([subscription], resolveQuery);
        if (resolved.resources.length > 0) {
          const r = resolved.resources[0];
          resourceId = r.id ?? resource;
          resourceType = r.type ?? "Unknown";
          resourceName = r.name ?? resource;
          resolvedResourceGroup = r.resourceGroup ?? resourceGroup;
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
      const metricConfig = getMetricConfig(resourceType);
      const [healthResult, activityResult, metricsResult] = await Promise.all([
        // 2. Check Resource Health
        getResourceHealth(subscription, resourceId),
        // 3. Pull Activity Log for this resource
        getActivityLogs(subscription, timeframeHours, resourceId),
        // 4. Pull metrics (if we know the resource type)
        metricConfig ? getMetrics(resourceId, metricConfig.names, timeframeHours) : Promise.resolve({ data: null, error: void 0 })
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
      const metricTrends = [];
      if (metricsResult.error) {
        errors.push(metricsResult.error);
      } else if (metricsResult.data && metricConfig) {
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
            if (dataPoints.length >= 3) {
              const trend = detectTrends(dataPoints, metric.name);
              if (trend.trend !== "stable") {
                metricTrends.push(trend);
              }
            }
          }
        }
      }
      const dependentResources = [];
      if (resolvedResourceGroup) {
        const depQueries = getDependencyQueries(resourceType, resolvedResourceGroup);
        if (depQueries.length > 0) {
          const depResults = await Promise.all(
            depQueries.map((dq) => queryResourceGraph([subscription], dq.query))
          );
          const allDeps = [];
          for (const result of depResults) {
            for (const dep of result.resources) {
              allDeps.push({
                id: dep.id,
                name: dep.name,
                type: dep.type
              });
            }
            if (result.error) {
              errors.push(result.error);
            }
          }
          const uniqueDeps = /* @__PURE__ */ new Map();
          for (const dep of allDeps) {
            if (!uniqueDeps.has(dep.id)) {
              uniqueDeps.set(dep.id, dep);
            }
          }
          const healthChecks = await batchExecute(
            Array.from(uniqueDeps.values()).map((dep) => async () => {
              const depHealth = await getResourceHealth(subscription, dep.id);
              const depState = depHealth.statuses[0]?.properties?.availabilityState ?? "Unknown";
              return { dep, depState };
            }),
            5
          );
          for (const { dep, depState } of healthChecks) {
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
      }
      let logAnalyticsInsights = [];
      if (resolvedResourceGroup) {
        const wsResult = await discoverWorkspaces(subscription, resolvedResourceGroup);
        if (wsResult.workspaces.length > 0) {
          const wsInsights = await batchExecute(
            wsResult.workspaces.map((ws) => async () => {
              const query = `union AppExceptions, AppRequests
| where TimeGenerated > ago(${timeframeHours}h)
| where Success == false or ExceptionType != ""
| summarize ErrorCount = count() by bin(TimeGenerated, 1h), OperationName
| order by ErrorCount desc
| take 5`;
              const result = await queryLogAnalytics(ws.workspaceId, query, timeframeHours);
              if (result.error) {
                errors.push(result.error);
                return null;
              }
              const errorCount = result.tables[0]?.rows?.length ?? 0;
              const topErrors = result.tables[0]?.rows?.map((row) => String(row[2] ?? "Unknown")).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 5) ?? [];
              return { workspace: ws.workspaceName, errorCount, topErrors };
            }),
            3
          );
          logAnalyticsInsights = wsInsights.filter((r) => r !== null);
        }
      }
      const correlation = correlateTimelines(allEvents);
      const diagnosticInsights = detectDiagnosticPatterns(allEvents, resourceType);
      const now = /* @__PURE__ */ new Date();
      const windowStart = new Date(
        now.getTime() - timeframeHours * 60 * 60 * 1e3
      );
      const errorSummary = formatErrorSummary(errors);
      const response = {
        resource: resourceName,
        resourceType,
        currentHealth,
        confidence: correlation.confidence,
        cascadingFailure: correlation.cascadingFailure,
        investigationWindow: `${windowStart.toISOString()} to ${now.toISOString()}`,
        symptom: symptom ?? null,
        timeline: correlation.timeline,
        likelyCause: correlation.likelyCause,
        earliestAnomaly: correlation.earliestAnomaly,
        precedingChanges: correlation.precedingChanges,
        dependentResources,
        diagnosticInsights: diagnosticInsights.length > 0 ? diagnosticInsights : void 0,
        metricTrends: metricTrends.length > 0 ? metricTrends : void 0,
        logAnalyticsInsights: logAnalyticsInsights.length > 0 ? logAnalyticsInsights : void 0,
        recommendedActions: buildRecommendations(
          currentHealth,
          correlation,
          dependentResources,
          symptom
        ),
        diagnosticCoverage: errorSummary.message,
        permissionGaps: errorSummary.permissionGaps.length > 0 ? errorSummary.permissionGaps : void 0,
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
function registerRca(server2) {
  server2.tool(
    "azdoctor_rca",
    "Generate a structured Root Cause Analysis document from investigation results. Produces markdown suitable for ServiceNow, post-incident reviews, or export.",
    {
      resource: z3.string().describe("Resource name or full Azure resource ID"),
      subscription: z3.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      incidentStart: z3.string().optional().describe("ISO timestamp for incident start"),
      incidentEnd: z3.string().optional().describe("ISO timestamp for incident resolution"),
      includeRecommendations: z3.boolean().default(true).describe("Whether to include follow-up recommendations"),
      outputFormat: z3.enum(["markdown", "json"]).default("markdown").describe("Output format: markdown for human-readable RCA, json for structured data")
    },
    async ({
      resource,
      subscription: subParam,
      incidentStart,
      incidentEnd,
      includeRecommendations,
      outputFormat
    }) => {
      const subscription = await resolveSubscription(subParam);
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
      const metricConfig = getMetricConfig(resourceType);
      const [healthResult, activityResult, metricsResult] = await Promise.all([
        getResourceHealth(subscription, resourceId),
        getActivityLogs(subscription, hoursBack, resourceId),
        metricConfig ? getMetrics(resourceId, metricConfig.names, hoursBack) : Promise.resolve({ data: null, error: void 0 })
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
      if (metricsResult.data && metricConfig) {
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
      const rcaInput = {
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
      };
      if (outputFormat === "json") {
        return {
          content: [{ type: "text", text: JSON.stringify({
            ...rcaInput,
            confidence: correlation.confidence,
            cascadingFailure: correlation.cascadingFailure,
            generatedAt: (/* @__PURE__ */ new Date()).toISOString()
          }, null, 2) }]
        };
      }
      const rca = formatRCA(rcaInput);
      return {
        content: [{ type: "text", text: rca }]
      };
    }
  );
}

// src/tools/checkPermissions.ts
import { z as z4 } from "zod";
var ROLE_RECOMMENDATIONS = {
  resourceGraph: "Assign Reader role \u2014 Resource Graph returns only resources the identity can read.",
  resourceHealth: "Assign Reader role on the subscription or resource.",
  activityLog: "Assign Reader role (includes Microsoft.Insights/eventtypes/*).",
  metrics: "Assign Reader role on the target resource.",
  logAnalytics: "Assign Log Analytics Reader on the workspace, or ensure workspace access mode allows resource-context queries."
};
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
function isForbidden(err) {
  const e = err;
  if (e.statusCode === 403) return true;
  if (e.code === "AuthorizationFailed") return true;
  if (typeof e.message === "string" && e.message.includes("AuthorizationFailed")) return true;
  return false;
}
function classifyErr(err, context) {
  if (isForbidden(err)) {
    return {
      accessible: false,
      status: "forbidden",
      detail: String(err.message ?? err),
      roleRecommendation: ROLE_RECOMMENDATIONS[context]
    };
  }
  return {
    accessible: false,
    status: "error",
    detail: String(err.message ?? err)
  };
}
var TIMEOUT_MS = 15e3;
async function probeResourceGraph(subscription) {
  try {
    const result = await withTimeout(
      queryResourceGraph([subscription], "Resources | take 1"),
      TIMEOUT_MS
    );
    if (result.error) {
      if (result.error.code === "FORBIDDEN") {
        return {
          accessible: false,
          status: "forbidden",
          detail: result.error.message,
          roleRecommendation: ROLE_RECOMMENDATIONS.resourceGraph
        };
      }
      return {
        accessible: false,
        status: "error",
        detail: result.error.message
      };
    }
    return { accessible: true, status: "ok" };
  } catch (err) {
    return classifyErr(err, "resourceGraph");
  }
}
async function probeResourceHealth(subscription) {
  try {
    const result = await withTimeout(
      batchResourceHealth(subscription),
      TIMEOUT_MS
    );
    if (result.error) {
      if (result.error.code === "FORBIDDEN") {
        return {
          accessible: false,
          status: "forbidden",
          detail: result.error.message,
          roleRecommendation: ROLE_RECOMMENDATIONS.resourceHealth
        };
      }
      return {
        accessible: false,
        status: "error",
        detail: result.error.message
      };
    }
    return { accessible: true, status: "ok" };
  } catch (err) {
    return classifyErr(err, "resourceHealth");
  }
}
async function probeActivityLog(subscription) {
  try {
    const result = await withTimeout(
      getActivityLogs(subscription, 1),
      TIMEOUT_MS
    );
    if (result.error) {
      if (result.error.code === "FORBIDDEN") {
        return {
          accessible: false,
          status: "forbidden",
          detail: result.error.message,
          roleRecommendation: ROLE_RECOMMENDATIONS.activityLog
        };
      }
      return {
        accessible: false,
        status: "error",
        detail: result.error.message
      };
    }
    return { accessible: true, status: "ok" };
  } catch (err) {
    return classifyErr(err, "activityLog");
  }
}
async function probeMetrics(resourceId) {
  if (!resourceId) {
    try {
      createMetricsQueryClient();
      return {
        accessible: false,
        status: "requires_resource",
        detail: "MetricsQueryClient created successfully, but a specific resource ID is required to test metric reads. Provide a resource URI when running metric-specific diagnostics."
      };
    } catch (err) {
      return classifyErr(err, "metrics");
    }
  }
  try {
    const result = await withTimeout(
      getMetrics(resourceId, ["Percentage CPU"], 1),
      TIMEOUT_MS
    );
    if (result.error) {
      if (result.error.code === "FORBIDDEN") {
        return {
          accessible: false,
          status: "forbidden",
          detail: result.error.message,
          roleRecommendation: ROLE_RECOMMENDATIONS.metrics
        };
      }
      return {
        accessible: false,
        status: "error",
        detail: result.error.message
      };
    }
    return { accessible: true, status: "ok" };
  } catch (err) {
    return classifyErr(err, "metrics");
  }
}
async function probeLogAnalytics(workspaceId) {
  if (!workspaceId) {
    return {
      accessible: false,
      status: "requires_workspace",
      detail: "Log Analytics requires a workspace ID to test. Provide a workspace ID when running log-specific diagnostics.",
      roleRecommendation: ROLE_RECOMMENDATIONS.logAnalytics
    };
  }
  try {
    const result = await withTimeout(
      queryLogAnalytics(workspaceId, "AzureActivity | take 1", 1),
      TIMEOUT_MS
    );
    if (result.error) {
      if (result.error.code === "FORBIDDEN") {
        return {
          accessible: false,
          status: "forbidden",
          detail: result.error.message,
          roleRecommendation: ROLE_RECOMMENDATIONS.logAnalytics
        };
      }
      return {
        accessible: false,
        status: "error",
        detail: result.error.message
      };
    }
    return { accessible: true, status: "ok" };
  } catch (err) {
    return classifyErr(err, "logAnalytics");
  }
}
function registerCheckPermissions(server2) {
  server2.tool(
    "azdoctor_check_permissions",
    "Detect what diagnostic data the current credentials can access and recommend role upgrades for fuller diagnostics.",
    {
      subscription: z4.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceId: z4.string().optional().describe("Optional Azure resource ID to test Metrics API access against"),
      workspaceId: z4.string().optional().describe("Optional Log Analytics workspace ID to test query access")
    },
    async ({ subscription: subParam, resourceId, workspaceId }) => {
      const subscription = await resolveSubscription(subParam);
      const [resourceGraph, resourceHealth, activityLog, metrics, logAnalytics] = await Promise.all([
        probeResourceGraph(subscription),
        probeResourceHealth(subscription),
        probeActivityLog(subscription),
        probeMetrics(resourceId),
        probeLogAnalytics(workspaceId)
      ]);
      const allChecks = [resourceGraph, resourceHealth, activityLog, metrics, logAnalytics];
      const testableResults = allChecks.filter(
        (r) => r.status !== "requires_resource" && r.status !== "requires_workspace"
      );
      const passCount = testableResults.filter((r) => r.accessible).length;
      let overallReadiness;
      if (testableResults.length === 0) {
        overallReadiness = "none";
      } else if (passCount === testableResults.length) {
        overallReadiness = "full";
      } else if (passCount > 0) {
        overallReadiness = "partial";
      } else {
        overallReadiness = "none";
      }
      const recommendations = [];
      const checks = { resourceGraph, resourceHealth, activityLog, metrics, logAnalytics };
      for (const [name, result] of Object.entries(checks)) {
        if (result.status === "forbidden" && result.roleRecommendation) {
          recommendations.push(
            `${name}: ${result.roleRecommendation}`
          );
        }
      }
      if (overallReadiness === "none") {
        recommendations.push(
          "No APIs are accessible. Verify that your credentials are valid (run 'az login') and that the subscription ID is correct."
        );
      }
      if (metrics.status === "requires_resource") {
        recommendations.push(
          "Metrics: To fully verify metrics access, run a diagnostic against a specific resource."
        );
      }
      if (metrics.status === "error") {
        recommendations.push(
          `Metrics: Access test against the provided resource failed. ${metrics.detail ?? "Check that the resource ID is valid and the metric name is supported."}`
        );
      }
      if (logAnalytics.status === "requires_workspace") {
        recommendations.push(
          "Log Analytics: To verify workspace access, provide a Log Analytics workspace ID."
        );
      }
      if (logAnalytics.status === "error") {
        recommendations.push(
          `Log Analytics: Access test against the provided workspace failed. ${logAnalytics.detail ?? "Check that the workspace ID is valid."}`
        );
      }
      if (overallReadiness === "full") {
        recommendations.push(
          "All testable APIs are accessible. Your credentials are well-configured for diagnostics."
        );
      }
      const report = {
        subscription,
        checks,
        overallReadiness,
        recommendations
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(report, null, 2)
          }
        ]
      };
    }
  );
}

// src/tools/compare.ts
import { z as z5 } from "zod";
var GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isSubscriptionId(scope) {
  return GUID_PATTERN.test(scope);
}
async function gatherScopeSummary(scope, subscription, mode, errors) {
  const isSubScope = isSubscriptionId(scope);
  const effectiveSubscription = isSubScope ? scope : subscription;
  const resourceGroup = isSubScope ? void 0 : scope;
  const promises = [
    // Resource inventory
    mode === "health" ? Promise.resolve({ resources: [], totalRecords: 0 }) : queryResourceGraph(
      [effectiveSubscription],
      resourceGroup ? `Resources | where resourceGroup =~ '${resourceGroup}' | summarize count() by type` : `Resources | summarize count() by type`
    ),
    // Resource Health
    mode === "resources" ? Promise.resolve({ statuses: [] }) : batchResourceHealth(effectiveSubscription, resourceGroup),
    // Activity logs (last 24h)
    mode === "resources" ? Promise.resolve({ events: [] }) : getActivityLogs(effectiveSubscription, 24, void 0, resourceGroup)
  ];
  const [resourceResult, healthResult, activityResult] = await Promise.all(promises);
  const resourceTypes = {};
  let totalResources = 0;
  if ("resources" in resourceResult) {
    if (resourceResult.error) errors.push(resourceResult.error);
    for (const row of resourceResult.resources) {
      const type = String(row.type ?? "unknown");
      const count = Number(row.count_ ?? row.count ?? 1);
      resourceTypes[type] = count;
      totalResources += count;
    }
  }
  let healthy = 0;
  let degraded = 0;
  let unavailable = 0;
  if ("statuses" in healthResult) {
    if (healthResult.error) errors.push(healthResult.error);
    for (const status of healthResult.statuses) {
      const state = status.properties?.availabilityState;
      if (state === "Unavailable") {
        unavailable++;
      } else if (state === "Degraded") {
        degraded++;
      } else {
        healthy++;
      }
    }
  }
  let recentChanges = 0;
  if ("events" in activityResult) {
    if (activityResult.error) errors.push(activityResult.error);
    recentChanges = activityResult.events.length;
  }
  return {
    scope,
    totalResources,
    resourceTypes,
    healthSummary: { healthy, degraded, unavailable },
    recentChanges
  };
}
function registerCompare(server2) {
  server2.tool(
    "azdoctor_compare",
    "Compare the health and configuration of two Azure scopes (resource groups or subscriptions). Useful for validating pre-deployment parity or diagnosing environment-specific issues.",
    {
      scopeA: z5.string().describe("First scope \u2014 resource group name or subscription ID"),
      scopeB: z5.string().describe("Second scope \u2014 resource group name or subscription ID"),
      subscription: z5.string().optional().describe(
        "Azure subscription ID (auto-detected if omitted). Used when comparing resource groups in the same subscription."
      ),
      mode: z5.enum(["health", "resources", "full"]).default("full").describe(
        "Comparison mode: health-only, resource inventory, or full comparison"
      )
    },
    async ({ scopeA, scopeB, subscription: subParam, mode }) => {
      const subscription = await resolveSubscription(subParam);
      const errors = [];
      const [summaryA, summaryB] = await Promise.all([
        gatherScopeSummary(scopeA, subscription, mode, errors),
        gatherScopeSummary(scopeB, subscription, mode, errors)
      ]);
      const differences = [];
      if (mode !== "health") {
        const typesA = new Set(Object.keys(summaryA.resourceTypes));
        const typesB = new Set(Object.keys(summaryB.resourceTypes));
        for (const type of typesA) {
          if (!typesB.has(type)) {
            differences.push({
              category: "resource_types",
              detail: `Resource type '${type}' exists in ${scopeA} (count: ${summaryA.resourceTypes[type]}) but not in ${scopeB}`,
              severity: "warning"
            });
          }
        }
        for (const type of typesB) {
          if (!typesA.has(type)) {
            differences.push({
              category: "resource_types",
              detail: `Resource type '${type}' exists in ${scopeB} (count: ${summaryB.resourceTypes[type]}) but not in ${scopeA}`,
              severity: "warning"
            });
          }
        }
        for (const type of typesA) {
          if (typesB.has(type)) {
            const countA = summaryA.resourceTypes[type];
            const countB = summaryB.resourceTypes[type];
            const max = Math.max(countA, countB);
            const diff = Math.abs(countA - countB);
            if (max > 0 && diff / max > 0.2) {
              differences.push({
                category: "resource_types",
                detail: `Resource type '${type}' count differs: ${scopeA} has ${countA}, ${scopeB} has ${countB} (${Math.round(diff / max * 100)}% difference)`,
                severity: "info"
              });
            }
          }
        }
      }
      if (mode !== "resources") {
        const unhealthyA = summaryA.healthSummary.degraded + summaryA.healthSummary.unavailable;
        const unhealthyB = summaryB.healthSummary.degraded + summaryB.healthSummary.unavailable;
        if (unhealthyA > 0 && unhealthyB === 0 || unhealthyB > 0 && unhealthyA === 0) {
          const affectedScope = unhealthyA > 0 ? scopeA : scopeB;
          const unhealthyCount = Math.max(unhealthyA, unhealthyB);
          differences.push({
            category: "health",
            detail: `${affectedScope} has ${unhealthyCount} unhealthy resource(s) while the other scope has none`,
            severity: "critical"
          });
        } else if (unhealthyA > 0 && unhealthyB > 0) {
          differences.push({
            category: "health",
            detail: `Both scopes have unhealthy resources: ${scopeA} has ${unhealthyA}, ${scopeB} has ${unhealthyB}`,
            severity: "critical"
          });
        }
        const changesA = summaryA.recentChanges;
        const changesB = summaryB.recentChanges;
        const minChanges = Math.min(changesA, changesB);
        const maxChanges = Math.max(changesA, changesB);
        if (minChanges > 0 && maxChanges / minChanges > 3) {
          const higherScope = changesA > changesB ? scopeA : scopeB;
          differences.push({
            category: "change_velocity",
            detail: `${higherScope} has significantly more activity (${maxChanges} events) compared to the other scope (${minChanges} events) \u2014 ${Math.round(maxChanges / minChanges)}x difference`,
            severity: "warning"
          });
        } else if (minChanges === 0 && maxChanges > 0) {
          const higherScope = changesA > changesB ? scopeA : scopeB;
          differences.push({
            category: "change_velocity",
            detail: `${higherScope} has ${maxChanges} recent activity event(s) while the other scope has none`,
            severity: "warning"
          });
        }
      }
      const hasCritical = differences.some((d) => d.severity === "critical");
      const hasWarning = differences.some((d) => d.severity === "warning");
      let parity;
      if (hasCritical) {
        parity = "divergent";
      } else if (hasWarning) {
        parity = "partial";
      } else {
        parity = "matched";
      }
      const response = {
        scopeA: summaryA,
        scopeB: summaryB,
        differences,
        parity,
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

// src/tools/remediate.ts
import { z as z6 } from "zod";
import { execSync as execSync2 } from "node:child_process";
var AVAILABLE_ACTIONS = [
  {
    action: "restart",
    description: "Restart the resource. Causes brief downtime.",
    risk: "low",
    reversible: true,
    applicableTo: ["microsoft.web/sites", "microsoft.cache/redis"],
    warning: "Causes 10-30 seconds of downtime during restart."
  },
  {
    action: "scale_up",
    description: "Change the resource SKU/tier to a higher performance level.",
    risk: "medium",
    reversible: true,
    applicableTo: [
      "microsoft.web/serverfarms",
      "microsoft.sql/servers/databases",
      "microsoft.cache/redis"
    ],
    warning: "May cause brief connectivity interruption during SKU change."
  },
  {
    action: "scale_out",
    description: "Increase the instance count for horizontal scaling.",
    risk: "low",
    reversible: true,
    applicableTo: ["microsoft.web/serverfarms"]
  },
  {
    action: "failover",
    description: "Trigger a manual failover to the secondary replica.",
    risk: "high",
    reversible: true,
    applicableTo: [
      "microsoft.sql/servers/databases",
      "microsoft.documentdb/databaseaccounts"
    ],
    warning: "Causes brief downtime during failover. Only use for geo-replicated resources."
  },
  {
    action: "flush_cache",
    description: "Flush all data from the Redis cache.",
    risk: "high",
    reversible: false,
    applicableTo: ["microsoft.cache/redis"],
    warning: "All cached data will be permanently lost. Applications may experience cold-start latency."
  }
];
function executeAzCommand(command, timeoutMs = 6e4) {
  try {
    const output = execSync2(command, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    return { success: true, output };
  } catch (err) {
    const e = err;
    return {
      success: false,
      output: "",
      error: e.stderr ?? e.message ?? String(err)
    };
  }
}
function parseServerNameFromId(resourceId) {
  const parts = resourceId.split("/");
  const serversIdx = parts.findIndex(
    (p) => p.toLowerCase() === "servers"
  );
  if (serversIdx !== -1 && parts.length > serversIdx + 1) {
    return parts[serversIdx + 1];
  }
  return void 0;
}
function parseResourceGroupFromId(resourceId) {
  const parts = resourceId.split("/");
  const rgIdx = parts.findIndex(
    (p) => p.toLowerCase() === "resourcegroups"
  );
  if (rgIdx !== -1 && parts.length > rgIdx + 1) {
    return parts[rgIdx + 1];
  }
  return void 0;
}
function parseSubscriptionFromId(resourceId) {
  const parts = resourceId.split("/");
  const subIdx = parts.findIndex(
    (p) => p.toLowerCase() === "subscriptions"
  );
  if (subIdx !== -1 && parts.length > subIdx + 1) {
    return parts[subIdx + 1];
  }
  return void 0;
}
function executeRestart(resourceType, resourceName, resourceGroup, subscription) {
  const normalizedType = resourceType.toLowerCase();
  if (normalizedType === "microsoft.web/sites") {
    const result = executeAzCommand(
      `az webapp restart --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription}`
    );
    return {
      ...result,
      rollbackHint: "No rollback needed \u2014 the app will recover automatically after restart."
    };
  }
  if (normalizedType === "microsoft.cache/redis") {
    const result = executeAzCommand(
      `az redis force-reboot --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --reboot-type AllNodes`
    );
    return {
      ...result,
      rollbackHint: "No rollback needed \u2014 Redis will recover automatically after reboot."
    };
  }
  return {
    success: false,
    output: "",
    error: `Restart is not supported for resource type '${resourceType}'.`,
    rollbackHint: ""
  };
}
function executeScaleUp(resourceType, resourceName, resourceGroup, subscription, scaleTarget, resourceId) {
  const normalizedType = resourceType.toLowerCase();
  if (normalizedType === "microsoft.web/serverfarms") {
    const currentSkuResult = executeAzCommand(
      `az appservice plan show --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --query sku.name -o tsv`
    );
    const previousSku = currentSkuResult.success ? currentSkuResult.output : "unknown";
    const result = executeAzCommand(
      `az appservice plan update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --sku ${scaleTarget}`
    );
    return {
      ...result,
      rollbackHint: `Previous SKU was ${previousSku}. To undo: az appservice plan update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --sku ${previousSku}`
    };
  }
  if (normalizedType === "microsoft.sql/servers/databases") {
    const serverName = parseServerNameFromId(resourceId);
    if (!serverName) {
      return {
        success: false,
        output: "",
        error: "Could not parse SQL server name from resource ID. Provide the full resource ID.",
        rollbackHint: ""
      };
    }
    const currentObjResult = executeAzCommand(
      `az sql db show --name ${resourceName} --resource-group ${resourceGroup} --server ${serverName} --subscription ${subscription} --query currentServiceObjectiveName -o tsv`
    );
    const previousObjective = currentObjResult.success ? currentObjResult.output : "unknown";
    const result = executeAzCommand(
      `az sql db update --name ${resourceName} --resource-group ${resourceGroup} --server ${serverName} --subscription ${subscription} --service-objective ${scaleTarget}`,
      12e4
    );
    return {
      ...result,
      rollbackHint: `Previous service objective was ${previousObjective}. To undo: az sql db update --name ${resourceName} --resource-group ${resourceGroup} --server ${serverName} --subscription ${subscription} --service-objective ${previousObjective}`
    };
  }
  if (normalizedType === "microsoft.cache/redis") {
    const currentSkuResult = executeAzCommand(
      `az redis show --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --query sku.name -o tsv`
    );
    const previousSku = currentSkuResult.success ? currentSkuResult.output : "unknown";
    const result = executeAzCommand(
      `az redis update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --sku ${scaleTarget}`,
      12e4
    );
    return {
      ...result,
      rollbackHint: `Previous SKU was ${previousSku}. To undo: az redis update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --sku ${previousSku}`
    };
  }
  return {
    success: false,
    output: "",
    error: `Scale up is not supported for resource type '${resourceType}'.`,
    rollbackHint: ""
  };
}
function executeScaleOut(resourceType, resourceName, resourceGroup, subscription, scaleTarget) {
  const normalizedType = resourceType.toLowerCase();
  if (normalizedType === "microsoft.web/serverfarms") {
    const currentCountResult = executeAzCommand(
      `az appservice plan show --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --query sku.capacity -o tsv`
    );
    const previousCount = currentCountResult.success ? currentCountResult.output : "unknown";
    const result = executeAzCommand(
      `az appservice plan update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --number-of-workers ${scaleTarget}`
    );
    return {
      ...result,
      rollbackHint: `Previous instance count was ${previousCount}. To undo: az appservice plan update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --number-of-workers ${previousCount}`
    };
  }
  return {
    success: false,
    output: "",
    error: `Scale out is not supported for resource type '${resourceType}'.`,
    rollbackHint: ""
  };
}
function executeFailover(resourceType, resourceName, resourceGroup, subscription, resourceId) {
  const normalizedType = resourceType.toLowerCase();
  if (normalizedType === "microsoft.sql/servers/databases") {
    const serverName = parseServerNameFromId(resourceId);
    if (!serverName) {
      return {
        success: false,
        output: "",
        error: "Could not parse SQL server name from resource ID. Provide the full resource ID.",
        rollbackHint: ""
      };
    }
    const result = executeAzCommand(
      `az sql db replica set-partner --name ${resourceName} --resource-group ${resourceGroup} --server ${serverName} --subscription ${subscription} --failover`,
      12e4
    );
    return {
      ...result,
      rollbackHint: "To fail back, run the same failover command targeting the original primary server."
    };
  }
  if (normalizedType === "microsoft.documentdb/databaseaccounts") {
    const result = executeAzCommand(
      `az cosmosdb failover-priority-change --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --failover-policies`,
      12e4
    );
    return {
      ...result,
      rollbackHint: "To fail back, trigger another failover-priority-change reversing the region priorities."
    };
  }
  return {
    success: false,
    output: "",
    error: `Failover is not supported for resource type '${resourceType}'.`,
    rollbackHint: ""
  };
}
function executeFlushCache(resourceType, resourceName, resourceGroup, subscription) {
  const normalizedType = resourceType.toLowerCase();
  if (normalizedType === "microsoft.cache/redis") {
    const result = executeAzCommand(
      `az redis flush --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --yes`
    );
    return {
      ...result,
      rollbackHint: "This action is NOT reversible. Cached data has been permanently deleted."
    };
  }
  return {
    success: false,
    output: "",
    error: `Flush cache is not supported for resource type '${resourceType}'.`,
    rollbackHint: ""
  };
}
function registerRemediate(server2) {
  server2.tool(
    "azdoctor_remediate",
    "Execute safe, reversible remediation actions on Azure resources. Supports restart, scale, failover, and cache flush operations with risk ratings and dry-run mode.",
    {
      resource: z6.string().describe("Resource name or full Azure resource ID"),
      subscription: z6.string().optional().describe("Azure subscription ID (auto-detected if omitted)"),
      resourceGroup: z6.string().optional().describe("Resource group name"),
      action: z6.enum([
        "restart",
        "scale_up",
        "scale_out",
        "failover",
        "flush_cache",
        "list_actions"
      ]).describe("Remediation action to execute"),
      dryRun: z6.boolean().default(true).describe(
        "When true (default), shows what would happen without executing. Set to false to actually execute."
      ),
      scaleTarget: z6.string().optional().describe(
        "Target SKU/tier for scale_up, or instance count for scale_out (e.g., 'P1v3' or '3')"
      )
    },
    async ({
      resource,
      subscription: subParam,
      resourceGroup,
      action,
      dryRun,
      scaleTarget
    }) => {
      const subscription = await resolveSubscription(subParam);
      let resourceId = resource;
      let resourceType = "Unknown";
      let resourceName = resource;
      let resolvedResourceGroup = resourceGroup;
      if (!resource.startsWith("/subscriptions/")) {
        const rgFilter = resourceGroup ? `| where resourceGroup =~ '${resourceGroup}'` : "";
        const resolveQuery = `Resources | where name =~ '${resource}' ${rgFilter} | project id, name, type, location, resourceGroup | take 1`;
        const resolved = await queryResourceGraph(
          [subscription],
          resolveQuery
        );
        if (resolved.resources.length > 0) {
          const r = resolved.resources[0];
          resourceId = r.id ?? resource;
          resourceType = r.type ?? "Unknown";
          resourceName = r.name ?? resource;
          resolvedResourceGroup = r.resourceGroup ?? resourceGroup;
        } else {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: `Could not resolve resource '${resource}'. Ensure the resource exists and you have Reader access.${resolved.error ? ` Details: ${resolved.error.message}` : ""}`
                  },
                  null,
                  2
                )
              }
            ]
          };
        }
      } else {
        const parts = resource.split("/");
        resourceName = parts[parts.length - 1] ?? resource;
        const providerIdx = parts.indexOf("providers");
        if (providerIdx !== -1 && parts.length > providerIdx + 2) {
          resourceType = `${parts[providerIdx + 1]}/${parts[providerIdx + 2]}`;
          if (parts.length > providerIdx + 4) {
            resourceType += `/${parts[providerIdx + 3]}`;
          }
        }
        resolvedResourceGroup = parseResourceGroupFromId(resource) ?? resourceGroup;
      }
      const normalizedType = resourceType.toLowerCase();
      if (action === "list_actions") {
        const applicable = AVAILABLE_ACTIONS.filter(
          (a) => a.applicableTo.includes(normalizedType)
        );
        const response2 = {
          resource: resourceName,
          resourceType,
          availableActions: applicable.length > 0 ? applicable : [],
          message: applicable.length > 0 ? `Found ${applicable.length} available remediation action(s) for ${resourceType}.` : `No remediation actions are currently available for resource type '${resourceType}'. Supported types: ${[
            ...new Set(
              AVAILABLE_ACTIONS.flatMap((a) => a.applicableTo)
            )
          ].join(", ")}`
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response2, null, 2)
            }
          ]
        };
      }
      const actionDef = AVAILABLE_ACTIONS.find((a) => a.action === action);
      if (!actionDef) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: `Unknown action '${action}'.` },
                null,
                2
              )
            }
          ]
        };
      }
      if (!actionDef.applicableTo.includes(normalizedType)) {
        const applicableActions = AVAILABLE_ACTIONS.filter(
          (a) => a.applicableTo.includes(normalizedType)
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Action '${action}' is not applicable to resource type '${resourceType}'.`,
                  availableActions: applicableActions.length > 0 ? applicableActions.map((a) => ({
                    action: a.action,
                    description: a.description,
                    risk: a.risk
                  })) : "No remediation actions available for this resource type."
                },
                null,
                2
              )
            }
          ]
        };
      }
      if ((action === "scale_up" || action === "scale_out") && !scaleTarget) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `The '${action}' action requires the 'scaleTarget' parameter.`,
                  hint: action === "scale_up" ? "Provide a target SKU/tier, e.g., 'P1v3', 'S3', 'Premium'." : "Provide a target instance count, e.g., '3'."
                },
                null,
                2
              )
            }
          ]
        };
      }
      if (!resolvedResourceGroup) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "Could not determine the resource group. Please provide the 'resourceGroup' parameter."
                },
                null,
                2
              )
            }
          ]
        };
      }
      const resolvedSubscription = parseSubscriptionFromId(resourceId) ?? subscription;
      if (dryRun) {
        const response2 = {
          action,
          resource: resourceName,
          resourceType,
          dryRun: true,
          risk: actionDef.risk,
          warning: actionDef.warning,
          executed: false,
          result: `DRY RUN: Would execute '${action}' on ${resourceName} (${resourceType}) in resource group '${resolvedResourceGroup}'.${scaleTarget ? ` Target: ${scaleTarget}.` : ""} Set dryRun to false to execute this action.`
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response2, null, 2)
            }
          ]
        };
      }
      let execResult;
      switch (action) {
        case "restart":
          execResult = executeRestart(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription
          );
          break;
        case "scale_up":
          execResult = executeScaleUp(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription,
            scaleTarget,
            resourceId
          );
          break;
        case "scale_out":
          execResult = executeScaleOut(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription,
            scaleTarget
          );
          break;
        case "failover":
          execResult = executeFailover(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription,
            resourceId
          );
          break;
        case "flush_cache":
          execResult = executeFlushCache(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription
          );
          break;
        default:
          execResult = {
            success: false,
            output: "",
            error: `Unhandled action '${action}'.`,
            rollbackHint: ""
          };
      }
      const response = {
        action,
        resource: resourceName,
        resourceType,
        dryRun: false,
        risk: actionDef.risk,
        warning: actionDef.warning,
        executed: execResult.success,
        result: execResult.success ? `Successfully executed '${action}' on ${resourceName}.${execResult.output ? ` Output: ${execResult.output}` : ""}` : void 0,
        error: execResult.error,
        rollbackHint: execResult.rollbackHint || void 0
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2)
          }
        ]
      };
    }
  );
}

// src/tools/query.ts
import { z as z7 } from "zod";
var QUERY_TEMPLATES = [
  {
    patterns: [/failed\s+requests?/i, /error\s+requests?/i, /5\d{2}\s+errors?/i, /http\s+errors?/i],
    table: "AppRequests",
    label: "failed requests",
    buildQuery: (_match, hours, maxRows) => `AppRequests
| where TimeGenerated > ago(${hours}h)
| where Success == false
| summarize FailedCount = count() by bin(TimeGenerated, 1h), OperationName, ResultCode
| order by FailedCount desc
| take ${maxRows}`,
    suggestions: [
      "Try 'slow requests' to check for latency issues",
      "Try 'exceptions' to see related application errors",
      "Try 'dependency failures' to check if a backend service is causing the errors"
    ]
  },
  {
    patterns: [/exceptions?/i, /crashes?/i, /unhandled/i, /stack\s*traces?/i],
    table: "AppExceptions",
    label: "exceptions",
    buildQuery: (_match, hours, maxRows) => `AppExceptions
| where TimeGenerated > ago(${hours}h)
| summarize ExceptionCount = count() by ExceptionType, OuterMessage, bin(TimeGenerated, 1h)
| order by ExceptionCount desc
| take ${maxRows}`,
    suggestions: [
      "Try 'failed requests' to see which HTTP requests are affected",
      "Try 'dependency failures' to check if exceptions are caused by downstream services"
    ]
  },
  {
    patterns: [/slow\s+requests?/i, /latency/i, /response\s+time/i, /performance/i],
    table: "AppRequests",
    label: "slow requests / latency",
    buildQuery: (_match, hours, maxRows) => `AppRequests
| where TimeGenerated > ago(${hours}h)
| where DurationMs > 1000
| summarize AvgDuration = avg(DurationMs), P95Duration = percentile(DurationMs, 95), Count = count() by OperationName, bin(TimeGenerated, 1h)
| order by P95Duration desc
| take ${maxRows}`,
    suggestions: [
      "Try 'dependency failures' to check if slow backends are causing latency",
      "Try 'cpu memory' to check resource utilization",
      "Try 'failed requests' to see if latency is leading to failures"
    ]
  },
  {
    patterns: [/dependency\s+failures?/i, /external\s+calls?/i, /backend\s+errors?/i, /downstream/i],
    table: "AppDependencies",
    label: "dependency failures",
    buildQuery: (_match, hours, maxRows) => `AppDependencies
| where TimeGenerated > ago(${hours}h)
| where Success == false
| summarize FailedCount = count() by DependencyType, Target, ResultCode, bin(TimeGenerated, 1h)
| order by FailedCount desc
| take ${maxRows}`,
    suggestions: [
      "Try 'failed requests' to see the impact on incoming requests",
      "Try 'exceptions' to see application-level errors from dependency failures"
    ]
  },
  {
    patterns: [/sign.?in/i, /login/i, /auth/i, /access\s+denied/i, /unauthorized/i, /401/i, /403/i],
    table: "SigninLogs",
    label: "sign-in / auth failures",
    buildQuery: (_match, hours, maxRows) => `SigninLogs
| where TimeGenerated > ago(${hours}h)
| where ResultType != "0"
| summarize FailureCount = count() by ResultType, ResultDescription, UserPrincipalName, AppDisplayName
| order by FailureCount desc
| take ${maxRows}`,
    suggestions: [
      "Try 'azure activity audit' to see related resource-level changes",
      "Try 'security alerts' to check for suspicious sign-in activity"
    ]
  },
  {
    patterns: [/azure\s+activity/i, /resource\s+changes?/i, /deployments?/i, /who\s+changed/i, /audit/i],
    table: "AzureActivity",
    label: "Azure activity / audit",
    buildQuery: (_match, hours, maxRows) => `AzureActivity
| where TimeGenerated > ago(${hours}h)
| where ActivityStatusValue == "Failure" or Level == "Error"
| summarize Count = count() by OperationNameValue, ActivityStatusValue, Caller, bin(TimeGenerated, 1h)
| order by Count desc
| take ${maxRows}`,
    suggestions: [
      "Try 'failed requests' to see if deployment changes caused application errors",
      "Try 'security alerts' to check for unauthorized activity"
    ]
  },
  {
    patterns: [/memory/i, /cpu/i, /resource\s+usage/i, /utilization/i],
    table: "Perf",
    label: "CPU / memory utilization",
    buildQuery: (_match, hours, maxRows) => `Perf
| where TimeGenerated > ago(${hours}h)
| where ObjectName == "Processor" or ObjectName == "Memory"
| summarize AvgValue = avg(CounterValue), MaxValue = max(CounterValue) by Computer, CounterName, bin(TimeGenerated, 1h)
| order by AvgValue desc
| take ${maxRows}`,
    suggestions: [
      "Try 'slow requests' to check if high resource usage is causing latency",
      "Try 'container pod errors' if running in Kubernetes"
    ]
  },
  {
    patterns: [/threat/i, /security\s+alert/i, /attack/i, /malicious/i, /suspicious/i],
    table: "SecurityAlert",
    label: "security alerts",
    buildQuery: (_match, hours, maxRows) => `SecurityAlert
| where TimeGenerated > ago(${hours}h)
| summarize AlertCount = count() by AlertName, AlertSeverity, ProviderName
| order by AlertCount desc
| take ${maxRows}`,
    suggestions: [
      "Try 'sign-in failures' to check for compromised accounts",
      "Try 'azure activity audit' to see related resource changes"
    ]
  },
  {
    patterns: [/container/i, /pod/i, /kubernetes/i, /k8s/i, /aks/i],
    table: "ContainerLogV2",
    label: "container / Kubernetes errors",
    buildQuery: (_match, hours, maxRows) => `ContainerLogV2
| where TimeGenerated > ago(${hours}h)
| where LogLevel in ("error", "critical", "fatal")
| summarize ErrorCount = count() by ContainerName, PodName, LogLevel, bin(TimeGenerated, 1h)
| order by ErrorCount desc
| take ${maxRows}`,
    suggestions: [
      "Try 'cpu memory' to check node resource utilization",
      "Try 'failed requests' to see the impact on incoming traffic"
    ]
  }
];
var KQL_KEYWORDS = /\b(where|summarize|project|extend|join|union|parse|render|make-series|mv-expand|evaluate)\b/i;
function isRawKql(description) {
  return description.includes("|") && KQL_KEYWORDS.test(description);
}
function matchTemplate(description, timeframeHours, maxRows) {
  for (const template of QUERY_TEMPLATES) {
    for (const pattern of template.patterns) {
      const match = description.match(pattern);
      if (match) {
        return {
          kql: template.buildQuery(match, timeframeHours, maxRows),
          matchedPattern: template.label,
          suggestions: template.suggestions
        };
      }
    }
  }
  return null;
}
function buildFallbackQuery(description, timeframeHours, maxRows) {
  const escaped = description.replace(/'/g, "\\'");
  return `union App*, Azure*, Syslog, SecurityEvent
| where TimeGenerated > ago(${timeframeHours}h)
| search "${escaped}"
| take ${maxRows}`;
}
function registerQueryTool(server2) {
  server2.tool(
    "azdoctor_query",
    "Generate and execute KQL queries against Log Analytics workspaces. Accepts natural language descriptions or raw KQL. Auto-discovers workspaces in the target resource group.",
    {
      description: z7.string().describe(
        "Natural language description of what to query (e.g., 'failed requests for prod-api in the last hour') or raw KQL query"
      ),
      subscription: z7.string().optional().describe("Azure subscription ID (auto-detected if omitted)"),
      resourceGroup: z7.string().optional().describe("Resource group containing the Log Analytics workspace"),
      workspaceId: z7.string().optional().describe("Specific Log Analytics workspace ID (auto-discovered if omitted)"),
      timeframeHours: z7.number().default(24).describe("How many hours back to query"),
      maxRows: z7.number().default(50).describe("Maximum rows to return")
    },
    async ({
      description,
      subscription,
      resourceGroup,
      workspaceId,
      timeframeHours,
      maxRows
    }) => {
      let resolvedWorkspaceId = workspaceId;
      let workspaceName;
      if (!resolvedWorkspaceId) {
        if (!resourceGroup) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: {
                      code: "MISSING_PARAMETER",
                      message: "Either 'workspaceId' or 'resourceGroup' must be provided so a Log Analytics workspace can be resolved."
                    }
                  },
                  null,
                  2
                )
              }
            ]
          };
        }
        const subscriptionId = await resolveSubscription(subscription);
        const discovery = await discoverWorkspaces(subscriptionId, resourceGroup);
        if (discovery.error) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: discovery.error },
                  null,
                  2
                )
              }
            ]
          };
        }
        if (discovery.workspaces.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: {
                      code: "NO_WORKSPACE",
                      message: `No Log Analytics workspaces found in resource group '${resourceGroup}'. Provide a specific workspaceId or check the resource group name.`
                    }
                  },
                  null,
                  2
                )
              }
            ]
          };
        }
        resolvedWorkspaceId = discovery.workspaces[0].workspaceId;
        workspaceName = discovery.workspaces[0].workspaceName;
      }
      let kql;
      let queryType;
      let matchedPattern;
      let suggestions;
      if (isRawKql(description)) {
        kql = description;
        queryType = "raw";
      } else {
        const templateResult = matchTemplate(description, timeframeHours, maxRows);
        if (templateResult) {
          kql = templateResult.kql;
          queryType = "generated";
          matchedPattern = templateResult.matchedPattern;
          suggestions = templateResult.suggestions;
        } else {
          kql = buildFallbackQuery(description, timeframeHours, maxRows);
          queryType = "generated";
          matchedPattern = "fallback (free-text search)";
          suggestions = [
            "Try more specific queries like 'failed requests', 'exceptions', 'slow requests', 'dependency failures', 'sign-in failures', 'cpu memory', 'security alerts', 'container pod errors', or 'azure activity audit'."
          ];
        }
      }
      const queryResult = await queryLogAnalytics(
        resolvedWorkspaceId,
        kql,
        timeframeHours
      );
      const firstTable = queryResult.tables[0];
      const response = {
        workspaceId: resolvedWorkspaceId,
        ...workspaceName ? { workspaceName } : {},
        queryType,
        kql,
        ...matchedPattern ? { matchedPattern } : {},
        timeframeHours,
        results: {
          columns: firstTable?.columns ?? [],
          rows: firstTable?.rows ?? [],
          rowCount: firstTable?.rows.length ?? 0
        },
        ...suggestions && suggestions.length > 0 ? { suggestions } : {},
        ...queryResult.error ? { error: queryResult.error } : {}
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2)
          }
        ]
      };
    }
  );
}

// src/tools/cost.ts
import { z as z8 } from "zod";
var VM_DOWNSIZE_MAP = {
  Standard_D4s_v3: "Standard_D2s_v3",
  Standard_D8s_v3: "Standard_D4s_v3",
  Standard_D16s_v3: "Standard_D8s_v3",
  Standard_D4s_v5: "Standard_D2s_v5",
  Standard_D8s_v5: "Standard_D4s_v5",
  Standard_D16s_v5: "Standard_D8s_v5",
  Standard_E4s_v3: "Standard_E2s_v3",
  Standard_E8s_v3: "Standard_E4s_v3",
  Standard_E4s_v5: "Standard_E2s_v5",
  Standard_E8s_v5: "Standard_E4s_v5",
  Standard_B4ms: "Standard_B2ms",
  Standard_B8ms: "Standard_B4ms",
  Standard_F4s_v2: "Standard_F2s_v2",
  Standard_F8s_v2: "Standard_F4s_v2"
};
var DISK_COST_PER_GB_MONTH = {
  Standard_LRS: 0.05,
  Premium_LRS: 0.12,
  StandardSSD_LRS: 0.075
};
function estimateDiskMonthlyCost(skuName, sizeGB) {
  const rate = DISK_COST_PER_GB_MONTH[skuName ?? ""] ?? 0.05;
  return rate * (sizeGB ?? 0);
}
function registerCost(server2) {
  server2.tool(
    "azdoctor_cost",
    "Analyze Azure resource costs and identify waste. Detects idle resources, oversized VMs, unattached storage, and recommends right-sizing based on usage metrics.",
    {
      subscription: z8.string().optional().describe("Azure subscription ID (auto-detected if omitted)"),
      resourceGroup: z8.string().optional().describe("Scope to a specific resource group"),
      lookbackDays: z8.number().default(7).describe("Days of metric history to analyze for right-sizing")
    },
    async ({ subscription: subParam, resourceGroup, lookbackDays }) => {
      const subscription = await resolveSubscription(subParam);
      const findings = [];
      const errors = [];
      const rgFilter = resourceGroup ? `resourceGroup =~ '${resourceGroup}' and ` : "";
      const [
        unattachedDisksResult,
        stoppedVmsResult,
        appServicePlansResult,
        unassociatedIpsResult,
        loadBalancersResult,
        runningVmsResult
      ] = await Promise.all([
        // Unattached disks
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Compute/disks' and properties.diskState == 'Unattached' | project id, name, type, location, resourceGroup, sku_name=tostring(sku.name), diskSizeGB=toint(properties.diskSizeGB)`
        ),
        // Stopped but allocated VMs
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Compute/virtualMachines' and properties.extended.instanceView.powerState.code == 'PowerState/stopped' | project id, name, type, location, resourceGroup, vmSize=tostring(properties.hardwareProfile.vmSize)`
        ),
        // App Service Plans (check for empty ones)
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Web/serverfarms' | project id, name, resourceGroup, sku_name=tostring(sku.name), sku_tier=tostring(sku.tier), numberOfSites=toint(properties.numberOfSites)`
        ),
        // Unassociated Public IPs
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Network/publicIPAddresses' and properties.ipConfiguration == '' | project id, name, resourceGroup, sku_name=tostring(sku.name)`
        ),
        // Load Balancers (check for idle ones)
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Network/loadBalancers' | project id, name, resourceGroup, sku_name=tostring(sku.name), backendPools=properties.backendAddressPools`
        ),
        // Running VMs for right-sizing analysis
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Compute/virtualMachines' and properties.extended.instanceView.powerState.code == 'PowerState/running' | project id, name, resourceGroup, vmSize=tostring(properties.hardwareProfile.vmSize)`
        )
      ]);
      let totalWasteCents = 0;
      let analyzedResources = 0;
      if (unattachedDisksResult.error) {
        errors.push(unattachedDisksResult.error);
      } else {
        for (const disk of unattachedDisksResult.resources) {
          analyzedResources++;
          const skuName = disk.sku_name;
          const sizeGB = disk.diskSizeGB;
          const monthlyCost = estimateDiskMonthlyCost(skuName, sizeGB);
          totalWasteCents += monthlyCost * 100;
          findings.push({
            category: "unattached_disk",
            resource: String(disk.name ?? "unknown"),
            resourceGroup: String(disk.resourceGroup ?? "unknown"),
            detail: `Unattached ${skuName ?? "unknown SKU"} disk, ${sizeGB ?? "?"}GB \u2014 incurring storage cost with no VM attached.`,
            estimatedMonthlyCost: `$${monthlyCost.toFixed(2)}`,
            recommendation: "Delete the disk if no longer needed, or snapshot it and delete to preserve data at lower cost.",
            savingsEstimate: `~$${Math.round(monthlyCost)}/month`
          });
        }
      }
      if (stoppedVmsResult.error) {
        errors.push(stoppedVmsResult.error);
      } else {
        for (const vm of stoppedVmsResult.resources) {
          analyzedResources++;
          findings.push({
            category: "stopped_vm",
            resource: String(vm.name ?? "unknown"),
            resourceGroup: String(vm.resourceGroup ?? "unknown"),
            detail: `VM is stopped but still allocated (size: ${vm.vmSize ?? "unknown"}). You are paying for reserved compute capacity.`,
            recommendation: "Deallocate the VM (Stop + Deallocate) to stop billing for compute, or delete it if no longer needed."
          });
        }
      }
      if (appServicePlansResult.error) {
        errors.push(appServicePlansResult.error);
      } else {
        for (const plan of appServicePlansResult.resources) {
          analyzedResources++;
          const numberOfSites = plan.numberOfSites;
          if (numberOfSites === 0) {
            const tier = plan.sku_tier;
            if (tier && tier !== "Free" && tier !== "Shared") {
              findings.push({
                category: "empty_plan",
                resource: String(plan.name ?? "unknown"),
                resourceGroup: String(plan.resourceGroup ?? "unknown"),
                detail: `App Service Plan (${plan.sku_name ?? "unknown"} / ${tier}) has no apps deployed \u2014 paying for idle compute.`,
                recommendation: "Delete the App Service Plan if no longer needed, or deploy an app to utilize the reserved capacity."
              });
            }
          }
        }
      }
      if (unassociatedIpsResult.error) {
        errors.push(unassociatedIpsResult.error);
      } else {
        for (const ip of unassociatedIpsResult.resources) {
          analyzedResources++;
          const skuName = ip.sku_name;
          const isStandard = skuName?.toLowerCase() === "standard" || skuName?.toLowerCase() === "standard_v2";
          const monthlyCost = isStandard ? 3.65 : 0;
          if (isStandard) {
            totalWasteCents += monthlyCost * 100;
          }
          findings.push({
            category: "unassociated_ip",
            resource: String(ip.name ?? "unknown"),
            resourceGroup: String(ip.resourceGroup ?? "unknown"),
            detail: `Public IP (${skuName ?? "unknown"} SKU) is not associated with any resource.`,
            estimatedMonthlyCost: isStandard ? `$${monthlyCost.toFixed(2)}` : void 0,
            recommendation: "Delete the public IP if no longer needed. Unassociated Standard IPs incur a monthly charge.",
            savingsEstimate: isStandard ? `~$${monthlyCost.toFixed(0)}/month` : void 0
          });
        }
      }
      if (loadBalancersResult.error) {
        errors.push(loadBalancersResult.error);
      } else {
        for (const lb of loadBalancersResult.resources) {
          analyzedResources++;
          const backendPools = lb.backendPools;
          const isEmpty = !backendPools || !Array.isArray(backendPools) || backendPools.length === 0;
          if (isEmpty) {
            findings.push({
              category: "idle_lb",
              resource: String(lb.name ?? "unknown"),
              resourceGroup: String(lb.resourceGroup ?? "unknown"),
              detail: `Load Balancer (${lb.sku_name ?? "unknown"} SKU) has no backend pools configured \u2014 it is not distributing any traffic.`,
              recommendation: "Delete the load balancer if no longer needed, or configure backend pools to utilize it."
            });
          }
        }
      }
      if (runningVmsResult.error) {
        errors.push(runningVmsResult.error);
      } else {
        const vmsToAnalyze = runningVmsResult.resources.slice(0, 10);
        analyzedResources += vmsToAnalyze.length;
        const metricTasks = vmsToAnalyze.map((vm) => {
          return async () => {
            const resourceId = vm.id;
            const vmName = String(vm.name ?? "unknown");
            const vmRg = String(vm.resourceGroup ?? "unknown");
            const vmSize = String(vm.vmSize ?? "unknown");
            const metricsResult = await getMetrics(
              resourceId,
              ["Percentage CPU"],
              lookbackDays * 24,
              "PT1H"
            );
            if (metricsResult.error) {
              errors.push(metricsResult.error);
              return;
            }
            if (!metricsResult.data) return;
            let totalCpu = 0;
            let dataPointCount = 0;
            for (const metric of metricsResult.data.metrics) {
              for (const ts of metric.timeseries) {
                for (const dp of ts.data ?? []) {
                  if (dp.average != null) {
                    totalCpu += dp.average;
                    dataPointCount++;
                  }
                }
              }
            }
            if (dataPointCount === 0) return;
            const avgCpu = totalCpu / dataPointCount;
            const downsizeTo = VM_DOWNSIZE_MAP[vmSize];
            if (avgCpu < 10) {
              findings.push({
                category: "oversized_vm",
                resource: vmName,
                resourceGroup: vmRg,
                detail: `VM (${vmSize}) is significantly oversized \u2014 average CPU usage is ${avgCpu.toFixed(1)}% over ${lookbackDays} days.`,
                recommendation: downsizeTo ? `Downsize from ${vmSize} to ${downsizeTo}, or consider a B-series burstable VM for this workload.` : `Consider downsizing to a smaller VM size. Current size ${vmSize} is significantly underutilized.`,
                savingsEstimate: downsizeTo ? "~50% compute cost reduction" : void 0
              });
            } else if (avgCpu < 30) {
              findings.push({
                category: "oversized_vm",
                resource: vmName,
                resourceGroup: vmRg,
                detail: `VM (${vmSize}) is potentially oversized \u2014 average CPU usage is ${avgCpu.toFixed(1)}% over ${lookbackDays} days.`,
                recommendation: downsizeTo ? `Consider downsizing from ${vmSize} to ${downsizeTo}.` : `Consider downsizing to a smaller VM size. Current size ${vmSize} appears underutilized.`,
                savingsEstimate: downsizeTo ? "~50% compute cost reduction" : void 0
              });
            }
          };
        });
        await batchExecute(metricTasks, 3);
      }
      const totalWasteDollars = totalWasteCents / 100;
      const result = {
        totalFindings: findings.length,
        estimatedMonthlyWaste: `$${totalWasteDollars.toFixed(2)}`,
        findings,
        analyzedResources,
        lookbackDays,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        errors: errors.length > 0 ? errors : void 0
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) }
        ]
      };
    }
  );
}

// src/tools/playback.ts
import { z as z9 } from "zod";
function registerPlayback(server2) {
  server2.tool(
    "azdoctor_playback",
    "Replay an incident timeline event-by-event in chronological order. Shows what happened, when, and provides context for each event \u2014 useful for post-incident learning and reviews.",
    {
      resource: z9.string().describe("Resource name or full Azure resource ID"),
      subscription: z9.string().optional(),
      startTime: z9.string().describe("ISO timestamp for playback start"),
      endTime: z9.string().optional().describe("ISO timestamp for playback end (defaults to now)"),
      includeContext: z9.boolean().default(true).describe("Include explanatory context for each event")
    },
    async ({ resource, subscription: subParam, startTime, endTime, includeContext }) => {
      const subscription = await resolveSubscription(subParam);
      const errors = [];
      const allEvents = [];
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
      const startDate = new Date(startTime);
      const endDate = endTime ? new Date(endTime) : /* @__PURE__ */ new Date();
      const hoursBack = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (60 * 60 * 1e3)));
      const metricConfig = getMetricConfig(resourceType);
      const [healthResult, activityResult, metricsResult] = await Promise.all([
        getResourceHealth(subscription, resourceId),
        getActivityLogs(subscription, hoursBack, resourceId),
        metricConfig ? getMetrics(resourceId, metricConfig.names, hoursBack) : Promise.resolve({ data: null, error: void 0 })
      ]);
      if (healthResult.error) {
        errors.push(healthResult.error);
      } else if (healthResult.statuses.length > 0) {
        const status = healthResult.statuses[0];
        const availState = status.properties?.availabilityState ?? "Unknown";
        if (availState !== "Available") {
          allEvents.push({
            time: (/* @__PURE__ */ new Date()).toISOString(),
            event: `Health status: ${availState} \u2014 ${status.properties?.summary ?? ""}`,
            source: "ResourceHealth",
            resource: resourceName,
            severity: availState === "Unavailable" ? "critical" : "warning"
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
      } else if (metricsResult.data && metricConfig) {
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
      const correlation = correlateTimelines(allEvents);
      const windowEvents = correlation.timeline.filter((e) => {
        const t = new Date(e.time).getTime();
        return t >= startDate.getTime() && t <= endDate.getTime();
      });
      const anomalyEvents = windowEvents.filter(
        (e) => e.source === "ResourceHealth" || e.source === "Metrics" || e.source === "ServiceHealth"
      );
      const firstAnomalyTime = anomalyEvents.length > 0 ? new Date(anomalyEvents[0].time).getTime() : null;
      const lastAnomalyTime = anomalyEvents.length > 0 ? new Date(anomalyEvents[anomalyEvents.length - 1].time).getTime() : null;
      let resolutionTime = null;
      if (lastAnomalyTime !== null) {
        const postAnomalyChanges = windowEvents.filter((e) => {
          const t = new Date(e.time).getTime();
          return t > lastAnomalyTime && e.source === "ActivityLog";
        });
        if (postAnomalyChanges.length > 0) {
          resolutionTime = new Date(postAnomalyChanges[0].time).getTime();
        }
      }
      const timeline = windowEvents.map((e) => {
        const t = new Date(e.time).getTime();
        let phaseMarker;
        if (firstAnomalyTime === null) {
          phaseMarker = "pre-incident";
        } else if (t < firstAnomalyTime) {
          phaseMarker = "pre-incident";
        } else if (t === firstAnomalyTime && anomalyEvents[0] === e) {
          phaseMarker = "incident-start";
        } else if (lastAnomalyTime !== null && t <= lastAnomalyTime) {
          phaseMarker = "during-incident";
        } else if (resolutionTime !== null && t <= resolutionTime && e.source === "ActivityLog") {
          phaseMarker = "resolution";
        } else if (lastAnomalyTime !== null && t > lastAnomalyTime) {
          phaseMarker = "post-incident";
        } else {
          phaseMarker = "during-incident";
        }
        const entry = {
          timestamp: e.time,
          event: e.event,
          source: e.source,
          actor: e.actor,
          severity: e.severity,
          phaseMarker
        };
        if (includeContext) {
          entry.context = generateContext(e);
        }
        return entry;
      });
      const preIncidentCount = timeline.filter((e) => e.phaseMarker === "pre-incident").length;
      const duringIncidentCount = timeline.filter((e) => e.phaseMarker === "during-incident").length;
      const postIncidentCount = timeline.filter((e) => e.phaseMarker === "post-incident").length;
      const incidentStartTimestamp = firstAnomalyTime ? new Date(firstAnomalyTime).toISOString() : null;
      const resolutionTimestamp = resolutionTime ? new Date(resolutionTime).toISOString() : null;
      const durationMs = endDate.getTime() - startDate.getTime();
      const durationHours = Math.floor(durationMs / (60 * 60 * 1e3));
      const durationMinutes = Math.floor(durationMs % (60 * 60 * 1e3) / (60 * 1e3));
      const durationStr = durationHours > 0 ? `${durationHours}h ${durationMinutes}m` : `${durationMinutes}m`;
      let summary = `${timeline.length} events over ${durationStr}.`;
      if (incidentStartTimestamp) {
        const startUtc = incidentStartTimestamp.replace("T", " ").replace(/\.\d+Z$/, " UTC");
        summary += ` Incident started at ${startUtc}`;
        if (resolutionTimestamp) {
          const resolveUtc = resolutionTimestamp.replace("T", " ").replace(/\.\d+Z$/, " UTC");
          summary += `, resolved at ${resolveUtc}.`;
        } else {
          summary += `, no clear resolution detected.`;
        }
      } else {
        summary += " No anomalies detected in the playback window.";
      }
      const response = {
        resource: resourceName,
        playbackWindow: `${startDate.toISOString()} to ${endDate.toISOString()}`,
        totalEvents: timeline.length,
        phases: {
          preIncident: preIncidentCount,
          incidentStart: incidentStartTimestamp,
          duringIncident: duringIncidentCount,
          resolution: resolutionTimestamp,
          postIncident: postIncidentCount
        },
        timeline,
        summary,
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
function generateContext(event) {
  const e = event.event.toLowerCase();
  if (event.source === "ActivityLog") {
    if (e.includes("write")) {
      return "A configuration change was made to the resource.";
    }
    if (e.includes("delete")) {
      return "A resource or component was deleted.";
    }
    if (e.includes("failed")) {
      return "This operation failed \u2014 check if it's related to the incident.";
    }
    return "An activity log event was recorded.";
  }
  if (event.source === "ResourceHealth") {
    if (e.includes("unavailable")) {
      return "Azure detected the resource as unavailable. This typically means the resource cannot serve requests.";
    }
    if (e.includes("degraded")) {
      return "The resource is experiencing reduced functionality or performance.";
    }
    return "A resource health status change was detected.";
  }
  if (event.source === "Metrics") {
    if (event.severity === "critical") {
      return "This metric exceeded the critical threshold, indicating severe resource pressure.";
    }
    if (event.severity === "warning") {
      return "This metric is elevated and approaching critical levels.";
    }
    return "A metric anomaly was detected.";
  }
  if (event.source === "ServiceHealth") {
    return "An Azure platform event was reported that may affect this resource.";
  }
  return "An event was recorded.";
}

// src/tools/alertRules.ts
import { z as z10 } from "zod";
var ALERT_TEMPLATES = {
  "microsoft.web/sites": [
    {
      name: "High Error Rate",
      metricName: "Http5xx",
      operator: "GreaterThan",
      threshold: 10,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 1,
      description: "Triggers when HTTP 5xx errors exceed 10 in 5 minutes"
    },
    {
      name: "Slow Response Time",
      metricName: "HttpResponseTime",
      operator: "GreaterThan",
      threshold: 5,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when average response time exceeds 5 seconds"
    },
    {
      name: "High CPU",
      metricName: "CpuPercentage",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when CPU exceeds 85% for 5 minutes"
    },
    {
      name: "High Memory",
      metricName: "MemoryPercentage",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when memory exceeds 85% for 5 minutes"
    },
    {
      name: "Health Check Failures",
      metricName: "HealthCheckStatus",
      operator: "LessThan",
      threshold: 100,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 1,
      description: "Triggers when health check success rate drops below 100%"
    }
  ],
  "microsoft.sql/servers/databases": [
    {
      name: "High DTU Usage",
      metricName: "dtu_consumption_percent",
      operator: "GreaterThan",
      threshold: 90,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when DTU consumption exceeds 90%"
    },
    {
      name: "Connection Failures",
      metricName: "connection_failed",
      operator: "GreaterThan",
      threshold: 5,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 1,
      description: "Triggers when failed connections exceed 5 in 5 minutes"
    },
    {
      name: "Deadlocks",
      metricName: "deadlock",
      operator: "GreaterThan",
      threshold: 1,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers on any deadlock occurrence"
    },
    {
      name: "High Storage Usage",
      metricName: "storage_percent",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT15M",
      frequency: "PT5M",
      severity: 2,
      description: "Triggers when storage exceeds 85%"
    }
  ],
  "microsoft.compute/virtualmachines": [
    {
      name: "High CPU",
      metricName: "Percentage CPU",
      operator: "GreaterThan",
      threshold: 90,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when CPU exceeds 90% for 5 minutes"
    },
    {
      name: "Low Available Memory",
      metricName: "Available Memory Bytes",
      operator: "LessThan",
      threshold: 1073741824,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when available memory drops below 1 GB"
    },
    {
      name: "Disk Queue Depth",
      metricName: "OS Disk Queue Depth",
      operator: "GreaterThan",
      threshold: 10,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when disk queue depth exceeds 10"
    }
  ],
  "microsoft.cache/redis": [
    {
      name: "High Server Load",
      metricName: "serverLoad",
      operator: "GreaterThan",
      threshold: 80,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when Redis server load exceeds 80%"
    },
    {
      name: "High Memory Usage",
      metricName: "usedmemorypercentage",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when memory usage exceeds 85%"
    }
  ],
  "microsoft.containerservice/managedclusters": [
    {
      name: "Node CPU Pressure",
      metricName: "node_cpu_usage_percentage",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when node CPU exceeds 85%"
    },
    {
      name: "Node Memory Pressure",
      metricName: "node_memory_rss_percentage",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when node memory exceeds 85%"
    }
  ]
};
function sanitizeBicepName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}
function tailorRecommendations(recommendations, investigationContext) {
  let tailored = false;
  try {
    const context = JSON.parse(investigationContext);
    const result = [...recommendations.map((r) => ({ ...r }))];
    if (context.cascadingFailure === true) {
      tailored = true;
      for (const rec of result) {
        if (rec.severity > 1) {
          rec.severity = rec.severity - 1;
        }
        rec.description += " [Severity escalated due to cascading failure risk]";
      }
    }
    if (Array.isArray(context.diagnosticInsights) && context.diagnosticInsights.length > 0) {
      tailored = true;
      for (const rec of result) {
        if (rec.operator === "GreaterThan") {
          rec.threshold = Math.round(rec.threshold * 0.85);
          rec.description += " [Threshold lowered based on diagnostic insights]";
        } else if (rec.operator === "LessThan") {
          rec.threshold = Math.round(rec.threshold * 1.15);
          rec.description += " [Threshold raised based on diagnostic insights]";
        }
      }
    }
    if (Array.isArray(context.metricTrends)) {
      const risingTrends = context.metricTrends.filter(
        (t) => t.direction === "rising"
      );
      if (risingTrends.length > 0) {
        tailored = true;
        for (const trend of risingTrends) {
          const metricName = trend.metricName || trend.metric;
          if (!metricName) continue;
          const existing = result.find((r) => r.metricName === metricName);
          if (existing) {
            const proactive = {
              ...existing,
              name: `Proactive: ${existing.name}`,
              threshold: existing.operator === "GreaterThan" ? Math.round(existing.threshold * 0.75) : Math.round(existing.threshold * 1.25),
              severity: Math.min(existing.severity + 1, 4),
              description: `Early warning: ${existing.description} [Proactive alert based on rising trend]`
            };
            result.push(proactive);
          }
        }
      }
    }
    return { recommendations: result, tailored };
  } catch {
    return { recommendations, tailored: false };
  }
}
function generateBicep(resourceId, recommendations) {
  const lines = [
    "// Auto-generated by AZ Doctor",
    "// Deploy: az deployment group create -g {resourceGroup} -f alerts.bicep",
    "",
    `param resourceId string = '${resourceId}'`,
    "param actionGroupId string = '' // Set to your Action Group resource ID",
    ""
  ];
  for (const rec of recommendations) {
    const sanitized = sanitizeBicepName(rec.name);
    lines.push(
      `resource alert_${sanitized} 'Microsoft.Insights/metricAlerts@2018-03-01' = {`,
      `  name: 'azdoctor-${rec.name.replace(/'/g, "")}'`,
      `  location: 'global'`,
      `  properties: {`,
      `    severity: ${rec.severity}`,
      `    enabled: true`,
      `    scopes: [resourceId]`,
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
      `          timeAggregation: 'Average'`,
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
function registerAlertRules(server2) {
  server2.tool(
    "azdoctor_alert_rules",
    "Generate Azure Monitor alert rule recommendations based on resource type and investigation findings. Outputs deployable Bicep templates.",
    {
      resource: z10.string().describe("Resource name or full Azure resource ID"),
      subscription: z10.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z10.string().optional().describe("Resource group name (helps resolve resource ID faster)"),
      outputFormat: z10.enum(["recommendations", "bicep"]).default("recommendations").describe(
        "Output as recommendations list or as deployable Bicep template"
      ),
      investigationContext: z10.string().optional().describe(
        "JSON output from a prior azdoctor_investigate call \u2014 used to tailor alerts to the specific issues found"
      )
    },
    async ({
      resource,
      subscription: subParam,
      resourceGroup,
      outputFormat,
      investigationContext
    }) => {
      const subscription = await resolveSubscription(subParam);
      let resourceId = resource;
      let resourceType = "Unknown";
      let resourceName = resource;
      let resolvedResourceGroup = resourceGroup;
      if (!resource.startsWith("/subscriptions/")) {
        const rgFilter = resourceGroup ? `| where resourceGroup =~ '${resourceGroup}'` : "";
        const resolveQuery = `Resources | where name =~ '${resource}' ${rgFilter} | project id, name, type, location, resourceGroup | take 1`;
        const resolved = await queryResourceGraph(
          [subscription],
          resolveQuery
        );
        if (resolved.resources.length > 0) {
          const r = resolved.resources[0];
          resourceId = r.id;
          resourceType = r.type.toLowerCase();
          resourceName = r.name;
          resolvedResourceGroup = r.resourceGroup;
        } else {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: `Could not find resource '${resource}' in subscription ${subscription}.`,
                    suggestion: "Provide the full resource ID or specify the resourceGroup parameter."
                  },
                  null,
                  2
                )
              }
            ]
          };
        }
      } else {
        const parts = resource.split("/");
        if (parts.length >= 9) {
          resourceType = `${parts[6]}/${parts[7]}`.toLowerCase();
          resourceName = parts[parts.length - 1];
          resolvedResourceGroup = parts[4];
        }
      }
      const templates = ALERT_TEMPLATES[resourceType];
      if (!templates) {
        const metricConfig = getMetricConfig(resourceType);
        const availableTypes = Object.keys(ALERT_TEMPLATES).join(", ");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  resource: resourceName,
                  resourceType,
                  error: `No alert templates available for resource type '${resourceType}'.`,
                  supportedTypes: availableTypes,
                  hasMetricConfig: !!metricConfig,
                  suggestion: metricConfig ? `Metric config exists for this type with metrics: ${metricConfig.names.join(", ")}. Custom alert rules can be crafted manually.` : "This resource type is not yet supported for alert recommendations."
                },
                null,
                2
              )
            }
          ]
        };
      }
      let recommendations = [...templates.map((t) => ({ ...t }))];
      let tailoredFromInvestigation = false;
      if (investigationContext) {
        const result = tailorRecommendations(
          recommendations,
          investigationContext
        );
        recommendations = result.recommendations;
        tailoredFromInvestigation = result.tailored;
      }
      const rg = resolvedResourceGroup || "{resourceGroup}";
      const deployCommand = `az deployment group create -g ${rg} -f alerts.bicep`;
      if (outputFormat === "bicep") {
        const bicep = generateBicep(resourceId, recommendations);
        return {
          content: [
            {
              type: "text",
              text: bicep
            }
          ]
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                resource: resourceName,
                resourceType,
                recommendations,
                tailoredFromInvestigation,
                totalAlerts: recommendations.length,
                deployCommand
              },
              null,
              2
            )
          }
        ]
      };
    }
  );
}

// src/tools/sweep.ts
import { z as z11 } from "zod";
import { execSync as execSync3 } from "node:child_process";
function registerSweep(server2) {
  server2.tool(
    "azdoctor_sweep",
    "Scan all accessible Azure subscriptions for health issues. Ranks subscriptions by risk score for a portfolio-wide view.",
    {
      severity: z11.enum(["critical", "warning", "info"]).default("warning").describe("Minimum severity threshold for reported findings")
    },
    async ({ severity }) => {
      const errors = [];
      let subscriptionIds;
      try {
        const output = execSync3('az account list --query "[].id" -o tsv', {
          encoding: "utf-8",
          timeout: 15e3,
          stdio: ["pipe", "pipe", "pipe"]
        }).trim();
        subscriptionIds = output.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "Failed to list subscriptions. Ensure you are logged in with 'az login'.",
                  details: String(err)
                },
                null,
                2
              )
            }
          ]
        };
      }
      if (subscriptionIds.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: "No subscriptions found. Run 'az login' first." },
                null,
                2
              )
            }
          ]
        };
      }
      let subscriptionNames = /* @__PURE__ */ new Map();
      try {
        const namesOutput = execSync3(
          'az account list --query "[].{id:id, name:name}" -o json',
          {
            encoding: "utf-8",
            timeout: 15e3,
            stdio: ["pipe", "pipe", "pipe"]
          }
        ).trim();
        const parsed = JSON.parse(namesOutput);
        for (const entry of parsed) {
          subscriptionNames.set(entry.id, entry.name);
        }
      } catch {
      }
      const PER_SUB_TIMEOUT = 2e4;
      function withTimeout2(promise, ms, fallback) {
        return Promise.race([
          promise,
          new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
        ]);
      }
      const scanTasks = subscriptionIds.map(
        (subId) => async () => {
          const subErrors = [];
          let totalResources = 0;
          let critical = 0;
          let warning = 0;
          const [rgResult, activityResult] = await withTimeout2(
            Promise.all([
              queryResourceGraph(
                [subId],
                "Resources | summarize total=count() | extend unhealthy=0"
              ),
              getActivityLogs(subId, 24)
            ]),
            PER_SUB_TIMEOUT,
            [
              { resources: [], totalRecords: 0, error: { code: "TIMEOUT", message: "Resource Graph scan timed out" } },
              { events: [], error: { code: "TIMEOUT", message: "Activity Log scan timed out" } }
            ]
          );
          if (rgResult.error) {
            subErrors.push(rgResult.error);
          } else if (rgResult.resources.length > 0) {
            totalResources = rgResult.resources[0]["total"] ?? 0;
          }
          if (activityResult.error) {
            subErrors.push(activityResult.error);
          } else {
            for (const event of activityResult.events) {
              if (event.status?.value === "Failed") {
                warning++;
              }
            }
          }
          const unhealthyResult = await withTimeout2(
            queryResourceGraph(
              [subId],
              "ResourceHealthResources | where properties.availabilityState != 'Available' | summarize critical=count()"
            ),
            1e4,
            { resources: [], totalRecords: 0, error: void 0 }
          );
          if (!unhealthyResult.error && unhealthyResult.resources.length > 0) {
            critical = unhealthyResult.resources[0]["critical"] ?? 0;
          }
          const riskScore = Math.min(100, critical * 30 + warning * 10);
          return {
            subscriptionId: subId,
            subscriptionName: subscriptionNames.get(subId),
            totalResources,
            critical,
            warning,
            riskScore,
            errors: subErrors
          };
        }
      );
      const scanResults = await batchExecute(scanTasks, 3);
      for (const result of scanResults) {
        errors.push(...result.errors);
      }
      const severityRank = {
        critical: 3,
        warning: 2,
        info: 1
      };
      const minRank = severityRank[severity] ?? 2;
      const rankings = scanResults.filter((r) => {
        if (minRank >= 3) return r.critical > 0;
        if (minRank >= 2) return r.critical > 0 || r.warning > 0;
        return true;
      }).map((r) => {
        const healthyCount = Math.max(
          0,
          r.totalResources - r.critical - r.warning
        );
        return {
          subscriptionId: r.subscriptionId,
          subscriptionName: r.subscriptionName,
          riskScore: r.riskScore,
          summary: `${r.critical} critical, ${r.warning} warning, ${healthyCount} healthy`,
          totalResources: r.totalResources,
          critical: r.critical,
          warning: r.warning
        };
      }).sort((a, b) => b.riskScore - a.riskScore);
      const allRankings = rankings.length > 0 ? rankings : scanResults.map((r) => {
        const healthyCount = Math.max(
          0,
          r.totalResources - r.critical - r.warning
        );
        return {
          subscriptionId: r.subscriptionId,
          subscriptionName: r.subscriptionName,
          riskScore: r.riskScore,
          summary: `${r.critical} critical, ${r.warning} warning, ${healthyCount} healthy`,
          totalResources: r.totalResources,
          critical: r.critical,
          warning: r.warning
        };
      }).sort((a, b) => b.riskScore - a.riskScore);
      const response = {
        subscriptionsScanned: subscriptionIds.length,
        rankings: allRankings,
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

// src/tools/baseline.ts
import { z as z12 } from "zod";
function calculateMean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
function calculateStdDev(values, mean) {
  if (values.length < 2) return 0;
  const sumSquaredDiffs = values.reduce(
    (sum, v) => sum + (v - mean) ** 2,
    0
  );
  return Math.sqrt(sumSquaredDiffs / (values.length - 1));
}
function registerBaseline(server2) {
  server2.tool(
    "azdoctor_baseline",
    "Compare current resource metrics against their 7-day baseline. Flags deviations beyond 2 standard deviations to answer 'is this normal?'",
    {
      resource: z12.string().describe("Resource name or full Azure resource ID"),
      subscription: z12.string().optional(),
      resourceGroup: z12.string().optional(),
      baselineDays: z12.number().default(7).describe("Days of history to use as baseline")
    },
    async ({ resource, subscription: subParam, resourceGroup, baselineDays }) => {
      const subscription = await resolveSubscription(subParam);
      let resourceId;
      let resourceType;
      if (resource.startsWith("/")) {
        resourceId = resource;
        const typeMatch = resource.match(
          /\/providers\/([^/]+\/[^/]+)/i
        );
        resourceType = typeMatch ? typeMatch[1] : "unknown";
      } else {
        const query = resourceGroup ? `Resources | where name =~ '${resource}' and resourceGroup =~ '${resourceGroup}' | project id, name, type | take 1` : `Resources | where name =~ '${resource}' | project id, name, type | take 1`;
        const rgResult = await queryResourceGraph([subscription], query);
        if (rgResult.error) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: `Failed to resolve resource: ${rgResult.error.message}`
                  },
                  null,
                  2
                )
              }
            ]
          };
        }
        if (rgResult.resources.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: `Resource '${resource}' not found in subscription ${subscription}${resourceGroup ? ` / resource group ${resourceGroup}` : ""}.`
                  },
                  null,
                  2
                )
              }
            ]
          };
        }
        const resolved = rgResult.resources[0];
        resourceId = resolved.id;
        resourceType = resolved.type;
      }
      const metricConfig = getMetricConfig(resourceType);
      if (!metricConfig) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `No metric configuration found for resource type '${resourceType}'. Baseline comparison is not supported for this resource type.`
                },
                null,
                2
              )
            }
          ]
        };
      }
      const timespanHours = baselineDays * 24;
      const metricsResult = await getMetrics(
        resourceId,
        metricConfig.names,
        timespanHours,
        "PT1H"
      );
      if (metricsResult.error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Failed to retrieve metrics: ${metricsResult.error.message}`
                },
                null,
                2
              )
            }
          ]
        };
      }
      if (!metricsResult.data) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: "No metric data returned." },
                null,
                2
              )
            }
          ]
        };
      }
      const baselineMetrics = [];
      for (const metric of metricsResult.data.metrics) {
        const metricName = metric.name;
        const timeSeries = metric.timeseries;
        if (!timeSeries || timeSeries.length === 0) continue;
        const allValues = [];
        let lastValue = null;
        for (const ts of timeSeries) {
          const dataPoints = ts.data ?? [];
          for (const dp of dataPoints) {
            const val = dp.average ?? dp.maximum;
            if (val !== void 0 && val !== null) {
              allValues.push(val);
              lastValue = val;
            }
          }
        }
        if (allValues.length < 2 || lastValue === null) continue;
        const mean = calculateMean(allValues);
        const stddev = calculateStdDev(allValues, mean);
        const current = lastValue;
        const zScore = stddev > 0 ? (current - mean) / stddev : 0;
        const absZ = Math.abs(zScore);
        let status;
        if (absZ >= 2) {
          status = "anomalous";
        } else if (absZ >= 1) {
          status = "elevated";
        } else {
          status = "normal";
        }
        let direction;
        if (zScore > 0.1) {
          direction = "above";
        } else if (zScore < -0.1) {
          direction = "below";
        } else {
          direction = "at";
        }
        const description = `${metricName} is ${absZ.toFixed(1)} standard deviations ${direction} the ${baselineDays}-day average (current: ${current.toFixed(1)}%, avg: ${mean.toFixed(1)}%)`;
        baselineMetrics.push({
          metricName,
          current: Math.round(current * 100) / 100,
          baselineMean: Math.round(mean * 100) / 100,
          baselineStdDev: Math.round(stddev * 100) / 100,
          zScore: Math.round(zScore * 100) / 100,
          status,
          direction,
          description
        });
      }
      const anomalousCount = baselineMetrics.filter(
        (m) => m.status === "anomalous"
      ).length;
      const elevatedCount = baselineMetrics.filter(
        (m) => m.status === "elevated"
      ).length;
      let overallStatus;
      if (anomalousCount >= 2) {
        overallStatus = "significant_anomalies";
      } else if (anomalousCount >= 1 || elevatedCount >= 2) {
        overallStatus = "some_anomalies";
      } else {
        overallStatus = "normal";
      }
      const response = {
        resource: resourceId,
        resourceType,
        baselineDays,
        overallStatus,
        metrics: baselineMetrics,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(response, null, 2) }
        ]
      };
    }
  );
}

// src/tools/journal.ts
import { z as z13 } from "zod";
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var JOURNAL_DIR = join(homedir(), ".azdoctor", "journal");
function ensureJournalDir() {
  mkdirSync(JOURNAL_DIR, { recursive: true });
}
function formatDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function sanitizeResourceName(resource) {
  return resource.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}
function registerJournal(server2) {
  server2.tool(
    "azdoctor_journal",
    "Persist investigation results as local markdown files. Builds an incident history for reference. Use 'save' to record an investigation, 'list' to see past entries, 'read' to view a specific entry.",
    {
      action: z13.enum(["save", "list", "read"]).describe("Action to perform"),
      resource: z13.string().optional().describe(
        "Resource name (required for save, optional filter for list)"
      ),
      content: z13.string().optional().describe(
        "Investigation output to save (required for save action)"
      ),
      entryId: z13.string().optional().describe(
        "Entry ID to read (required for read action, returned by list)"
      )
    },
    async ({ action, resource, content, entryId }) => {
      if (action === "save") {
        if (!resource) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: "The 'resource' parameter is required for the save action." },
                  null,
                  2
                )
              }
            ]
          };
        }
        if (!content) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: "The 'content' parameter is required for the save action." },
                  null,
                  2
                )
              }
            ]
          };
        }
        ensureJournalDir();
        const now = /* @__PURE__ */ new Date();
        const safeName = sanitizeResourceName(resource);
        const dateStr = formatDate(now);
        const filename = `${safeName}-${dateStr}.md`;
        const filepath = join(JOURNAL_DIR, filename);
        const entryIdValue = filename.replace(/\.md$/, "");
        const markdown = `# Investigation: ${resource}
**Date:** ${now.toISOString()}
**Resource:** ${resource}

## Diagnostic Output
${content}

---
*Saved by AZ Doctor*
`;
        writeFileSync(filepath, markdown, "utf-8");
        const response = {
          saved: true,
          path: filepath,
          entryId: entryIdValue
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2)
            }
          ]
        };
      }
      if (action === "list") {
        ensureJournalDir();
        let files;
        try {
          files = readdirSync(JOURNAL_DIR).filter((f) => f.endsWith(".md"));
        } catch {
          files = [];
        }
        if (resource) {
          const safeResource = sanitizeResourceName(resource);
          files = files.filter(
            (f) => f.toLowerCase().startsWith(safeResource)
          );
        }
        const entries = files.map((f) => {
          const entryIdValue = f.replace(/\.md$/, "");
          const filepath = join(JOURNAL_DIR, f);
          let entryResource = "unknown";
          let entryDate = "";
          try {
            const fileContent = readFileSync(filepath, "utf-8");
            const lines = fileContent.split(/\r?\n/);
            for (const line of lines) {
              const resourceMatch = line.match(/^\*\*Resource:\*\*\s*(.+)$/);
              if (resourceMatch) {
                entryResource = resourceMatch[1].trim();
              }
              const dateMatch = line.match(/^\*\*Date:\*\*\s*(.+)$/);
              if (dateMatch) {
                entryDate = dateMatch[1].trim();
              }
            }
          } catch {
          }
          return {
            entryId: entryIdValue,
            resource: entryResource,
            date: entryDate,
            path: filepath
          };
        }).sort((a, b) => b.date.localeCompare(a.date));
        const response = {
          entries,
          totalEntries: entries.length
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2)
            }
          ]
        };
      }
      if (action === "read") {
        if (!entryId) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: "The 'entryId' parameter is required for the read action." },
                  null,
                  2
                )
              }
            ]
          };
        }
        ensureJournalDir();
        const filename = entryId.endsWith(".md") ? entryId : `${entryId}.md`;
        const filepath = join(JOURNAL_DIR, filename);
        if (!existsSync(filepath)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: `Entry '${entryId}' not found. Use the 'list' action to see available entries.`
                  },
                  null,
                  2
                )
              }
            ]
          };
        }
        const fileContent = readFileSync(filepath, "utf-8");
        const response = {
          entryId,
          content: fileContent
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2)
            }
          ]
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: `Unknown action: ${action}` },
              null,
              2
            )
          }
        ]
      };
    }
  );
}

// src/tools/playbooks.ts
import { z as z14 } from "zod";
import {
  mkdirSync as mkdirSync2,
  writeFileSync as writeFileSync2,
  readdirSync as readdirSync2,
  readFileSync as readFileSync2,
  existsSync as existsSync2
} from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var PLAYBOOKS_DIR = join2(homedir2(), ".azdoctor", "playbooks");
function parseFrontmatter(content) {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: null, body: content };
  }
  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return { frontmatter: null, body: content };
  }
  const yamlBlock = trimmed.substring(3, endIndex).trim();
  const body = trimmed.substring(endIndex + 3).trim();
  try {
    const parsed = parseSimpleYaml(yamlBlock);
    const triggers = parsed["triggers"] ?? {};
    const frontmatter = {
      name: String(parsed["name"] ?? ""),
      description: String(parsed["description"] ?? ""),
      triggers: {
        resourceTypes: toStringArray(triggers["resourceTypes"]),
        patterns: toStringArray(triggers["patterns"]),
        metrics: toStringArray(triggers["metrics"]),
        symptoms: toStringArray(triggers["symptoms"])
      },
      severity: String(parsed["severity"] ?? "info")
    };
    return { frontmatter, body };
  } catch {
    return { frontmatter: null, body: content };
  }
}
function toStringArray(value) {
  if (Array.isArray(value)) return value.map(String);
  return [];
}
function parseSimpleYaml(yaml) {
  const result = {};
  const lines = yaml.split("\n");
  let currentKey = null;
  let currentNested = null;
  let currentArrayKey = null;
  let currentArray = null;
  for (const rawLine of lines) {
    if (rawLine.trim() === "") continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (line.startsWith("- ")) {
      const value = line.substring(2).trim();
      if (currentArray !== null && currentArrayKey !== null) {
        currentArray.push(value);
        continue;
      }
    }
    if (currentArray !== null && currentArrayKey !== null) {
      if (currentNested !== null) {
        currentNested[currentArrayKey] = currentArray;
      } else {
        result[currentArrayKey] = currentArray;
      }
      currentArray = null;
      currentArrayKey = null;
    }
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.substring(0, colonIndex).trim();
    const valueStr = line.substring(colonIndex + 1).trim();
    if (indent === 0) {
      if (currentKey !== null && currentNested !== null) {
        result[currentKey] = currentNested;
        currentNested = null;
      }
      if (valueStr === "") {
        currentKey = key;
        currentNested = {};
      } else {
        currentKey = null;
        currentNested = null;
        result[key] = valueStr;
      }
    } else if (indent > 0 && currentKey !== null) {
      if (valueStr === "") {
        currentArrayKey = key;
        currentArray = [];
      } else {
        if (currentNested !== null) {
          currentNested[key] = valueStr;
        }
      }
    }
  }
  if (currentArray !== null && currentArrayKey !== null) {
    if (currentNested !== null) {
      currentNested[currentArrayKey] = currentArray;
    } else {
      result[currentArrayKey] = currentArray;
    }
  }
  if (currentKey !== null && currentNested !== null) {
    result[currentKey] = currentNested;
  }
  return result;
}
function loadPlaybooks() {
  if (!existsSync2(PLAYBOOKS_DIR)) return [];
  const files = readdirSync2(PLAYBOOKS_DIR).filter((f) => f.endsWith(".md"));
  const playbooks = [];
  for (const fileName of files) {
    try {
      const filePath = join2(PLAYBOOKS_DIR, fileName);
      const raw = readFileSync2(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);
      if (frontmatter && frontmatter.name) {
        playbooks.push({ frontmatter, body, fileName, raw });
      }
    } catch {
    }
  }
  return playbooks;
}
var SAMPLE_HIGH_MEMORY = `---
name: high-memory-app-service
description: Diagnose and resolve high memory usage on App Service
triggers:
  resourceTypes:
    - microsoft.web/sites
    - microsoft.web/serverfarms
  patterns:
    - memory_exhaustion
    - cpu_saturation
  metrics:
    - MemoryPercentage
    - CpuPercentage
  symptoms:
    - slow
    - oom
    - out of memory
    - high memory
severity: warning
---

# High Memory on App Service

## Diagnosis Steps

1. Check if the App Service Plan is shared with other apps that may be consuming memory
2. Review Application Insights for memory-intensive operations
3. Check for memory leaks by comparing memory trends over 24h vs 7d
4. Look for recent deployments that may have introduced memory regression

## Common Root Causes

- **Memory leak in application code** \u2014 memory grows steadily over time without releasing
- **Large in-memory caches** \u2014 application caching too much data
- **Oversized payloads** \u2014 processing large files or responses in memory
- **Too many apps on shared plan** \u2014 noisy neighbor effect

## Remediation

1. **Immediate**: Restart the App Service to reclaim memory
2. **Short-term**: Scale up the App Service Plan to a higher memory tier
3. **Long-term**: Profile the application for memory leaks, optimize caching strategy

## Escalation

If memory usage returns to high levels within 1 hour after restart, the application likely has a memory leak. Engage the development team for profiling.
`;
var SAMPLE_CONNECTION_FAILURES = `---
name: database-connection-failures
description: Diagnose database connection failures and pool exhaustion
triggers:
  resourceTypes:
    - microsoft.sql/servers/databases
    - microsoft.dbformysql/flexibleservers
    - microsoft.dbforpostgresql/flexibleservers
  patterns:
    - connection_storm
    - dtu_exhaustion
  metrics:
    - connection_failed
    - dtu_consumption_percent
  symptoms:
    - connection
    - timeout
    - pool
    - cannot connect
severity: critical
---

# Database Connection Failures

## Diagnosis Steps

1. Check connection_failed metric for spike timing
2. Correlate with activity logs for recent firewall rule or configuration changes
3. Check DTU/CPU consumption \u2014 connection failures often accompany resource exhaustion
4. Verify connection string and firewall rules haven't changed
5. Check if connection pool settings match the database tier's max connections

## Common Root Causes

- **Connection pool exhaustion** \u2014 application not releasing connections
- **Database tier too small** \u2014 max connections exceeded for the tier
- **Firewall rule changes** \u2014 recent network configuration blocking connections
- **Password rotation** \u2014 credentials expired or rotated without app update

## Remediation

1. **Immediate**: Check and increase the database tier if DTU is saturated
2. **Short-term**: Review application connection pool settings (min/max pool size, timeout)
3. **Long-term**: Implement connection retry logic with exponential backoff
`;
function matchPlaybooks(playbooks, context) {
  const results = [];
  const resourceType = String(context["resourceType"] ?? context["resource_type"] ?? "").toLowerCase();
  const detectedPatterns = extractStringArray(context, "patterns", "detectedPatterns", "diagnosticPatterns");
  const anomalousMetrics = extractStringArray(context, "metrics", "anomalousMetrics", "metricNames");
  const symptoms = extractStringArray(context, "symptoms", "userSymptoms", "description");
  const descriptionText = String(context["description"] ?? context["symptom"] ?? context["issue"] ?? "").toLowerCase();
  for (const playbook of playbooks) {
    const matchedTriggers = [];
    const triggers = playbook.frontmatter.triggers;
    if (resourceType && triggers.resourceTypes.length > 0) {
      for (const rt of triggers.resourceTypes) {
        if (resourceType.includes(rt.toLowerCase()) || rt.toLowerCase().includes(resourceType)) {
          matchedTriggers.push(`resourceType:${rt}`);
          break;
        }
      }
    }
    for (const pattern of triggers.patterns) {
      const patternLower = pattern.toLowerCase();
      if (detectedPatterns.some((p) => p.toLowerCase() === patternLower)) {
        matchedTriggers.push(`pattern:${pattern}`);
      }
    }
    for (const metric of triggers.metrics) {
      const metricLower = metric.toLowerCase();
      if (anomalousMetrics.some((m) => m.toLowerCase().includes(metricLower) || metricLower.includes(m.toLowerCase()))) {
        matchedTriggers.push(`metric:${metric}`);
      }
    }
    for (const symptom of triggers.symptoms) {
      const symptomLower = symptom.toLowerCase();
      const matched = symptoms.some((s) => s.toLowerCase().includes(symptomLower)) || descriptionText.includes(symptomLower);
      if (matched) {
        matchedTriggers.push(`symptom:${symptom}`);
      }
    }
    if (matchedTriggers.length > 0) {
      let relevance;
      if (matchedTriggers.length >= 3) {
        relevance = "high";
      } else if (matchedTriggers.length === 2) {
        relevance = "medium";
      } else {
        relevance = "low";
      }
      results.push({
        name: playbook.frontmatter.name,
        description: playbook.frontmatter.description,
        relevance,
        matchedTriggers,
        content: playbook.raw
      });
    }
  }
  const relevanceOrder = { high: 0, medium: 1, low: 2 };
  results.sort(
    (a, b) => (relevanceOrder[a.relevance] ?? 2) - (relevanceOrder[b.relevance] ?? 2)
  );
  return results;
}
function extractStringArray(context, ...keys) {
  for (const key of keys) {
    const value = context[key];
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null) {
          const obj = item;
          return String(obj["pattern"] ?? obj["name"] ?? obj["metric"] ?? obj["metricName"] ?? "");
        }
        return String(item);
      }).filter((s) => s !== "");
    }
    if (typeof value === "string" && value.trim() !== "") {
      return [value];
    }
  }
  return [];
}
function registerPlaybooks(server2) {
  server2.tool(
    "azdoctor_playbooks",
    "Manage custom diagnostic playbooks. Users can create playbooks in ~/.azdoctor/playbooks/ to define custom diagnostic patterns and remediation steps. Use 'list' to see available playbooks, 'show' to view one, or 'match' to find playbooks relevant to an investigation.",
    {
      action: z14.enum(["list", "show", "match", "init"]).describe(
        "Action: list available playbooks, show a specific one, match against investigation findings, or init to create a sample playbook"
      ),
      playbookName: z14.string().optional().describe("Playbook name (required for 'show' action)"),
      investigationContext: z14.string().optional().describe(
        "JSON output from azdoctor_investigate \u2014 used by 'match' action to find relevant playbooks"
      )
    },
    async ({ action, playbookName, investigationContext }) => {
      try {
        switch (action) {
          case "list": {
            const playbooks = loadPlaybooks();
            const listing = playbooks.map((p) => ({
              name: p.frontmatter.name,
              fileName: p.fileName,
              description: p.frontmatter.description,
              resourceTypes: p.frontmatter.triggers.resourceTypes,
              triggers: [
                ...p.frontmatter.triggers.patterns,
                ...p.frontmatter.triggers.symptoms
              ],
              severity: p.frontmatter.severity
            }));
            const result = {
              playbooksDir: PLAYBOOKS_DIR,
              playbooks: listing,
              totalPlaybooks: listing.length
            };
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          case "show": {
            if (!playbookName) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error: "playbookName is required for the 'show' action."
                    })
                  }
                ],
                isError: true
              };
            }
            const playbooks = loadPlaybooks();
            const nameLower = playbookName.toLowerCase();
            const found = playbooks.find(
              (p) => p.frontmatter.name.toLowerCase() === nameLower || p.fileName.replace(/\.md$/, "").toLowerCase() === nameLower
            );
            if (!found) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error: `Playbook not found: "${playbookName}". Use the 'list' action to see available playbooks.`,
                      availablePlaybooks: playbooks.map(
                        (p) => p.frontmatter.name
                      )
                    })
                  }
                ],
                isError: true
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: found.raw
                }
              ]
            };
          }
          case "match": {
            if (!investigationContext) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error: "investigationContext is required for the 'match' action. Pass the JSON output from azdoctor_investigate."
                    })
                  }
                ],
                isError: true
              };
            }
            let context;
            try {
              context = JSON.parse(investigationContext);
            } catch {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error: "Failed to parse investigationContext as JSON. Ensure it is valid JSON from azdoctor_investigate."
                    })
                  }
                ],
                isError: true
              };
            }
            const playbooks = loadPlaybooks();
            if (playbooks.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      matchedPlaybooks: [],
                      totalMatched: 0,
                      investigatedResource: String(
                        context["resource"] ?? context["resourceId"] ?? "unknown"
                      ),
                      hint: `No playbooks found in ${PLAYBOOKS_DIR}. Run the 'init' action to create sample playbooks.`
                    })
                  }
                ]
              };
            }
            const matched = matchPlaybooks(playbooks, context);
            const investigatedResource = String(
              context["resource"] ?? context["resourceId"] ?? "unknown"
            );
            const result = {
              matchedPlaybooks: matched,
              totalMatched: matched.length,
              investigatedResource
            };
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          case "init": {
            mkdirSync2(PLAYBOOKS_DIR, { recursive: true });
            const sampleFiles = [];
            const highMemoryPath = join2(
              PLAYBOOKS_DIR,
              "example-high-memory.md"
            );
            if (!existsSync2(highMemoryPath)) {
              writeFileSync2(highMemoryPath, SAMPLE_HIGH_MEMORY.trimStart(), "utf-8");
              sampleFiles.push("example-high-memory.md");
            }
            const connFailuresPath = join2(
              PLAYBOOKS_DIR,
              "example-connection-failures.md"
            );
            if (!existsSync2(connFailuresPath)) {
              writeFileSync2(
                connFailuresPath,
                SAMPLE_CONNECTION_FAILURES.trimStart(),
                "utf-8"
              );
              sampleFiles.push("example-connection-failures.md");
            }
            const result = {
              initialized: true,
              playbooksDir: PLAYBOOKS_DIR,
              samplePlaybooksCreated: sampleFiles
            };
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          default: {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: `Unknown action: ${action}`
                  })
                }
              ],
              isError: true
            };
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: message })
            }
          ],
          isError: true
        };
      }
    }
  );
}

// src/tools/triage.ts
import { z as z15 } from "zod";
import { mkdirSync as mkdirSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir3 } from "node:os";
var TRIAGE_ALERT_TEMPLATES = {
  "microsoft.web/sites": [
    { name: "Error Rate", metric: "Http5xx", threshold: 10, description: "HTTP 5xx > 10 in 5min" },
    { name: "High CPU", metric: "CpuPercentage", threshold: 85, description: "CPU > 85% for 5min" },
    { name: "High Memory", metric: "MemoryPercentage", threshold: 85, description: "Memory > 85% for 5min" },
    { name: "Slow Response", metric: "HttpResponseTime", threshold: 5, description: "Avg response > 5s" }
  ],
  "microsoft.sql/servers/databases": [
    { name: "DTU Saturation", metric: "dtu_consumption_percent", threshold: 90, description: "DTU > 90% for 5min" },
    { name: "Connection Failures", metric: "connection_failed", threshold: 5, description: "Failed connections > 5 in 5min" },
    { name: "Deadlocks", metric: "deadlock", threshold: 1, description: "Any deadlock detected" }
  ],
  "microsoft.compute/virtualmachines": [
    { name: "High CPU", metric: "Percentage CPU", threshold: 90, description: "CPU > 90% for 5min" },
    { name: "Disk I/O", metric: "OS Disk Queue Depth", threshold: 10, description: "Disk queue > 10" }
  ],
  "microsoft.cache/redis": [
    { name: "Server Load", metric: "serverLoad", threshold: 80, description: "Server load > 80%" },
    { name: "Memory Usage", metric: "usedmemorypercentage", threshold: 85, description: "Memory > 85%" }
  ]
};
var JOURNAL_DIR2 = join3(homedir3(), ".azdoctor", "journal");
function ensureJournalDir2() {
  mkdirSync3(JOURNAL_DIR2, { recursive: true });
}
function formatDateForFilename(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function sanitizeResourceName2(resource) {
  return resource.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}
function computeBaseline(dataPoints, metricName) {
  const values = [];
  for (const dp of dataPoints) {
    const v = dp.average ?? dp.maximum;
    if (v !== void 0) values.push(v);
  }
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const current = values[values.length - 1];
  const zScore = stdDev !== 0 ? (current - mean) / stdDev : 0;
  let status;
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
    status
  };
}
function buildRemediationSuggestions(insights, currentHealth, dependentResources) {
  const suggestions = [];
  for (const insight of insights) {
    if (insight.recommendation && !suggestions.includes(insight.recommendation)) {
      suggestions.push(insight.recommendation);
    }
  }
  if (currentHealth === "Unavailable" || currentHealth === "Degraded") {
    suggestions.push(
      "Check Azure Service Health for ongoing platform incidents in the resource's region."
    );
  }
  const unhealthyDeps = dependentResources.filter((d) => d.health !== "Available");
  for (const dep of unhealthyDeps) {
    suggestions.push(
      `Investigate dependent resource ${dep.name} (${dep.type}) \u2014 currently ${dep.health}.`
    );
  }
  if (suggestions.length === 0) {
    suggestions.push(
      "No clear root cause identified from available signals.",
      "Search Microsoft Learn docs for troubleshooting guidance specific to this resource type."
    );
  }
  return suggestions;
}
function buildJournalMarkdown(report) {
  const insightsBullets = report.diagnosticInsights.length > 0 ? report.diagnosticInsights.map((i) => `- **${i.pattern}** (${i.confidence}): ${i.description}`).join("\n") : "- No diagnostic patterns detected.";
  const trendsBullets = report.metricTrends.length > 0 ? report.metricTrends.map((t) => `- ${t.description}`).join("\n") : "- All monitored metrics are stable.";
  const baselineRows = report.baseline.metrics.length > 0 ? "| Metric | Current | Mean | StdDev | Z-Score | Status |\n|--------|---------|------|--------|---------|--------|\n" + report.baseline.metrics.map(
    (m) => `| ${m.metric} | ${m.current} | ${m.mean} | ${m.stdDev} | ${m.zScore} | ${m.status} |`
  ).join("\n") : "No baseline metrics available.";
  const alertsBullets = report.alertRecommendations.length > 0 ? report.alertRecommendations.map((a) => `- **${a.name}**: ${a.description} (metric: ${a.metric}, threshold: ${a.threshold})`).join("\n") : "- No alert recommendations for this resource type.";
  return `# Triage Report: ${report.resource}
**Date:** ${report.timestamp}
**Type:** ${report.resourceType}
**Health:** ${report.currentHealth}
**Confidence:** ${report.confidence}

## Root Cause
${report.likelyCause}

## Diagnostic Insights
${insightsBullets}

## Metric Trends
${trendsBullets}

## Baseline Status
${baselineRows}

## Topology
\`\`\`
${report.topology}
\`\`\`

## Recommended Alerts
${alertsBullets}

---
*Auto-saved by AZ Doctor triage*
`;
}
function registerTriage(server2) {
  server2.tool(
    "azdoctor_triage",
    "Run the full diagnostic pipeline on a resource in one command. Chains: permission check \u2192 multi-signal investigation \u2192 baseline comparison \u2192 alert recommendations \u2192 auto-saves to journal. Returns a comprehensive triage report.",
    {
      resource: z15.string().describe("Resource name or full Azure resource ID"),
      subscription: z15.string().optional().describe("Azure subscription ID (auto-detected if omitted)"),
      resourceGroup: z15.string().optional().describe("Resource group name"),
      symptom: z15.string().optional().describe("User-described symptom"),
      timeframeHours: z15.number().default(24).describe("Investigation lookback window in hours"),
      baselineDays: z15.number().default(7).describe("Baseline comparison lookback in days"),
      saveToJournal: z15.boolean().default(true).describe("Auto-save the triage report to the incident journal"),
      generateAlerts: z15.boolean().default(true).describe("Generate alert rule recommendations")
    },
    async ({
      resource,
      subscription: subParam,
      resourceGroup,
      symptom,
      timeframeHours,
      baselineDays,
      saveToJournal,
      generateAlerts
    }) => {
      const startTime = Date.now();
      const errors = [];
      const allEvents = [];
      const subscription = await resolveSubscription(subParam);
      let resourceId = resource;
      let resourceType = "Unknown";
      let resourceName = resource;
      let resolvedResourceGroup = resourceGroup;
      if (!resource.startsWith("/subscriptions/")) {
        const rgFilter = resourceGroup ? `| where resourceGroup =~ '${resourceGroup}'` : "";
        const resolveQuery = `Resources | where name =~ '${resource}' ${rgFilter} | project id, name, type, location, resourceGroup | take 1`;
        const resolved = await queryResourceGraph([subscription], resolveQuery);
        if (resolved.resources.length > 0) {
          const r = resolved.resources[0];
          resourceId = r.id ?? resource;
          resourceType = r.type ?? "Unknown";
          resourceName = r.name ?? resource;
          resolvedResourceGroup = r.resourceGroup ?? resourceGroup;
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
      const permissionsCheck = {
        resourceHealth: false,
        activityLog: false,
        metrics: false,
        logAnalytics: false,
        summary: ""
      };
      const metricConfig = getMetricConfig(resourceType);
      const [healthResult, activityResult, metricsResult, workspacesResult] = await Promise.all([
        getResourceHealth(subscription, resourceId),
        getActivityLogs(subscription, timeframeHours, resourceId),
        metricConfig ? getMetrics(resourceId, metricConfig.names, timeframeHours) : Promise.resolve({ data: null, error: void 0 }),
        resolvedResourceGroup ? discoverWorkspaces(subscription, resolvedResourceGroup) : Promise.resolve({ workspaces: [], error: void 0 })
      ]);
      permissionsCheck.resourceHealth = !healthResult.error;
      permissionsCheck.activityLog = !activityResult.error;
      permissionsCheck.metrics = !metricsResult.error;
      permissionsCheck.logAnalytics = !workspacesResult.error;
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
          const timestamp2 = event.eventTimestamp?.toISOString() ?? (/* @__PURE__ */ new Date()).toISOString();
          allEvents.push({
            time: timestamp2,
            event: `${opName} (${status})`,
            source: "ActivityLog",
            resource: resourceName,
            actor: event.caller,
            severity: status === "Failed" ? "warning" : "info"
          });
        }
      }
      const metricTrends = [];
      const metricDataByName = /* @__PURE__ */ new Map();
      if (metricsResult.error) {
        errors.push(metricsResult.error);
      } else if (metricsResult.data && metricConfig) {
        for (const metric of metricsResult.data.metrics) {
          for (const ts of metric.timeseries) {
            if (!ts.data) continue;
            const dataPoints = ts.data.filter(
              (dp) => dp.average !== void 0 || dp.maximum !== void 0
            ).map((dp) => ({
              timestamp: dp.timeStamp?.toISOString() ?? (/* @__PURE__ */ new Date()).toISOString(),
              average: dp.average ?? void 0,
              maximum: dp.maximum ?? void 0
            }));
            metricDataByName.set(metric.name, dataPoints);
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
            if (dataPoints.length >= 3) {
              const trend = detectTrends(dataPoints, metric.name);
              if (trend.trend !== "stable") {
                metricTrends.push(trend);
              }
            }
          }
        }
      }
      const dependentResources = [];
      if (resolvedResourceGroup) {
        const depQueries = getDependencyQueries(resourceType, resolvedResourceGroup);
        if (depQueries.length > 0) {
          const depResults = await Promise.all(
            depQueries.map((dq) => queryResourceGraph([subscription], dq.query))
          );
          const allDeps = [];
          for (const result of depResults) {
            for (const dep of result.resources) {
              allDeps.push({
                id: dep.id,
                name: dep.name,
                type: dep.type
              });
            }
            if (result.error) {
              errors.push(result.error);
            }
          }
          const uniqueDeps = /* @__PURE__ */ new Map();
          for (const dep of allDeps) {
            if (!uniqueDeps.has(dep.id)) {
              uniqueDeps.set(dep.id, dep);
            }
          }
          const healthChecks = await batchExecute(
            Array.from(uniqueDeps.values()).map((dep) => async () => {
              const depHealth = await getResourceHealth(subscription, dep.id);
              const depState = depHealth.statuses[0]?.properties?.availabilityState ?? "Unknown";
              return { dep, depState };
            }),
            5
          );
          for (const { dep, depState } of healthChecks) {
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
      }
      const correlation = correlateTimelines(allEvents);
      const diagnosticInsights = detectDiagnosticPatterns(allEvents, resourceType);
      const baselineMetrics = [];
      if (metricConfig) {
        const baselineHours = baselineDays * 24;
        const baselineResult = await getMetrics(
          resourceId,
          metricConfig.names,
          baselineHours,
          "PT1H"
        );
        if (baselineResult.error) {
          errors.push(baselineResult.error);
        } else if (baselineResult.data) {
          for (const metric of baselineResult.data.metrics) {
            for (const ts of metric.timeseries) {
              if (!ts.data) continue;
              const dataPoints = ts.data.filter(
                (dp) => dp.average !== void 0 || dp.maximum !== void 0
              ).map((dp) => ({
                timestamp: dp.timeStamp?.toISOString() ?? (/* @__PURE__ */ new Date()).toISOString(),
                average: dp.average ?? void 0,
                maximum: dp.maximum ?? void 0
              }));
              const bl = computeBaseline(dataPoints, metric.name);
              if (bl) baselineMetrics.push(bl);
            }
          }
        }
      }
      const anomalousCount = baselineMetrics.filter((m) => m.status === "anomalous").length;
      const elevatedCount = baselineMetrics.filter((m) => m.status === "elevated").length;
      let baselineOverallStatus;
      if (anomalousCount > 0) {
        baselineOverallStatus = `${anomalousCount} metric(s) anomalous`;
      } else if (elevatedCount > 0) {
        baselineOverallStatus = `${elevatedCount} metric(s) elevated`;
      } else {
        baselineOverallStatus = "All metrics within normal range";
      }
      const rootNode = {
        name: resourceName,
        type: resourceType,
        health: currentHealth === "Available" ? "Available" : currentHealth === "Degraded" ? "Degraded" : currentHealth === "Unavailable" ? "Unavailable" : "Unknown",
        isRoot: true
      };
      const depNodes = dependentResources.map((d) => ({
        name: d.name,
        type: d.type,
        health: d.health === "Available" ? "Available" : d.health === "Degraded" ? "Degraded" : d.health === "Unavailable" ? "Unavailable" : "Unknown",
        isRoot: false
      }));
      const topologyAscii = renderTopology(rootNode, depNodes);
      const alertRecommendations = generateAlerts ? TRIAGE_ALERT_TEMPLATES[resourceType.toLowerCase()] ?? [] : [];
      const remediationSuggestions = buildRemediationSuggestions(
        diagnosticInsights,
        currentHealth,
        dependentResources
      );
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      const durationMs = Date.now() - startTime;
      const triageDuration = `${(durationMs / 1e3).toFixed(1)}s`;
      const accessibleAPIs = [];
      const inaccessibleAPIs = [];
      if (permissionsCheck.resourceHealth) accessibleAPIs.push("Resource Health");
      else inaccessibleAPIs.push("Resource Health");
      if (permissionsCheck.activityLog) accessibleAPIs.push("Activity Log");
      else inaccessibleAPIs.push("Activity Log");
      if (permissionsCheck.metrics) accessibleAPIs.push("Metrics");
      else inaccessibleAPIs.push("Metrics");
      if (permissionsCheck.logAnalytics) accessibleAPIs.push("Log Analytics");
      else inaccessibleAPIs.push("Log Analytics");
      permissionsCheck.summary = inaccessibleAPIs.length === 0 ? "All APIs accessible \u2014 full diagnostic data available." : `${accessibleAPIs.length}/4 APIs accessible. Inaccessible: ${inaccessibleAPIs.join(", ")}.`;
      let journalSaved = false;
      let journalPath;
      if (saveToJournal) {
        try {
          ensureJournalDir2();
          const now = /* @__PURE__ */ new Date();
          const filename = `triage-${sanitizeResourceName2(resourceName)}-${formatDateForFilename(now)}.md`;
          journalPath = join3(JOURNAL_DIR2, filename);
          const markdownContent = buildJournalMarkdown({
            resource: resourceName,
            resourceType,
            timestamp,
            currentHealth,
            confidence: correlation.confidence,
            likelyCause: correlation.likelyCause,
            diagnosticInsights,
            metricTrends,
            baseline: {
              overallStatus: baselineOverallStatus,
              metrics: baselineMetrics,
              lookbackDays: baselineDays
            },
            topology: topologyAscii,
            alertRecommendations
          });
          writeFileSync3(journalPath, markdownContent, "utf-8");
          journalSaved = true;
        } catch {
          journalSaved = false;
        }
      }
      const errorSummary = formatErrorSummary(errors);
      const response = {
        // Header
        resource: resourceName,
        resourceType,
        subscription,
        timestamp,
        triageDuration,
        // Permissions
        permissions: permissionsCheck,
        // Investigation
        currentHealth,
        confidence: correlation.confidence,
        cascadingFailure: correlation.cascadingFailure,
        likelyCause: correlation.likelyCause,
        timeline: correlation.timeline,
        diagnosticInsights: diagnosticInsights.length > 0 ? diagnosticInsights : [],
        metricTrends: metricTrends.length > 0 ? metricTrends : [],
        // Dependencies
        topology: topologyAscii,
        dependentResources: dependentResources.map((d) => ({
          name: d.name,
          type: d.type,
          health: d.health
        })),
        // Baseline
        baseline: {
          overallStatus: baselineOverallStatus,
          metrics: baselineMetrics,
          lookbackDays: baselineDays
        },
        // Recommendations
        alertRecommendations,
        remediationSuggestions,
        // Journal
        journalSaved,
        journalPath,
        // Errors
        diagnosticCoverage: errorSummary.message,
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

// src/tools/diagram.ts
import { z as z16 } from "zod";
function registerDiagram(server2) {
  server2.tool(
    "azdoctor_diagram",
    "Generate Mermaid diagrams from investigation data. Produces dependency topology diagrams and incident timeline diagrams that render in GitHub, VS Code, and documentation tools.",
    {
      resource: z16.string().describe("Resource name or full Azure resource ID"),
      subscription: z16.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z16.string().optional().describe("Resource group name (helps resolve resource ID faster)"),
      diagramType: z16.enum(["topology", "timeline", "both"]).default("both").describe("Type of diagram to generate"),
      timeframeHours: z16.number().default(24).describe("Lookback window for timeline diagram")
    },
    async ({
      resource,
      subscription: subParam,
      resourceGroup,
      diagramType,
      timeframeHours
    }) => {
      const subscription = await resolveSubscription(subParam);
      const errors = [];
      let resourceId = resource;
      let resourceType = "Unknown";
      let resourceName = resource;
      let resolvedResourceGroup = resourceGroup;
      if (!resource.startsWith("/subscriptions/")) {
        const rgFilter = resourceGroup ? `| where resourceGroup =~ '${resourceGroup}'` : "";
        const resolveQuery = `Resources | where name =~ '${resource}' ${rgFilter} | project id, name, type, location, resourceGroup | take 1`;
        const resolved = await queryResourceGraph([subscription], resolveQuery);
        if (resolved.resources.length > 0) {
          const r = resolved.resources[0];
          resourceId = r.id ?? resource;
          resourceType = r.type ?? "Unknown";
          resourceName = r.name ?? resource;
          resolvedResourceGroup = r.resourceGroup ?? resourceGroup;
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
      let topologyMermaid;
      let topologyAscii;
      let dependencyCount = 0;
      if (diagramType === "topology" || diagramType === "both") {
        const rootHealthResult = await getResourceHealth(subscription, resourceId);
        const rootHealth = rootHealthResult.statuses[0]?.properties?.availabilityState ?? "Unknown";
        if (rootHealthResult.error) {
          errors.push(rootHealthResult.error);
        }
        const rootNode = {
          name: resourceName,
          type: resourceType,
          health: rootHealth,
          isRoot: true
        };
        const depNodes = [];
        if (resolvedResourceGroup) {
          const depQueries = getDependencyQueries(resourceType, resolvedResourceGroup);
          if (depQueries.length > 0) {
            const depResults = await Promise.all(
              depQueries.map((dq) => queryResourceGraph([subscription], dq.query))
            );
            const allDeps = /* @__PURE__ */ new Map();
            for (const result of depResults) {
              for (const dep of result.resources) {
                const depId = dep.id;
                if (!allDeps.has(depId)) {
                  allDeps.set(depId, {
                    id: depId,
                    name: dep.name,
                    type: dep.type
                  });
                }
              }
              if (result.error) {
                errors.push(result.error);
              }
            }
            const healthChecks = await batchExecute(
              Array.from(allDeps.values()).map((dep) => async () => {
                const depHealth = await getResourceHealth(subscription, dep.id);
                const depState = depHealth.statuses[0]?.properties?.availabilityState ?? "Unknown";
                return { dep, depState };
              }),
              5
            );
            for (const { dep, depState } of healthChecks) {
              depNodes.push({
                name: dep.name,
                type: dep.type,
                health: depState,
                isRoot: false
              });
            }
          }
        }
        dependencyCount = depNodes.length;
        topologyMermaid = renderMermaidTopology(rootNode, depNodes);
        topologyAscii = renderTopology(rootNode, depNodes);
      }
      let timelineMermaid;
      let eventCount = 0;
      if (diagramType === "timeline" || diagramType === "both") {
        const allEvents = [];
        const metricConfig = getMetricConfig(resourceType);
        const [healthResult, activityResult, metricsResult] = await Promise.all([
          getResourceHealth(subscription, resourceId),
          getActivityLogs(subscription, timeframeHours, resourceId),
          metricConfig ? getMetrics(resourceId, metricConfig.names, timeframeHours) : Promise.resolve({ data: null, error: void 0 })
        ]);
        if (healthResult.error) {
          errors.push(healthResult.error);
        } else if (healthResult.statuses.length > 0) {
          const status = healthResult.statuses[0];
          const currentHealth = status.properties?.availabilityState ?? "Unknown";
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
        } else if (metricsResult.data && metricConfig) {
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
        const correlation = correlateTimelines(allEvents);
        eventCount = correlation.timeline.length;
        timelineMermaid = renderMermaidTimeline(
          correlation.timeline.map((e) => ({
            time: e.time,
            event: e.event,
            source: e.source,
            severity: e.severity
          }))
        );
      }
      const diagrams = {};
      if (topologyMermaid !== void 0) {
        diagrams.topology = {
          mermaid: topologyMermaid,
          ascii: topologyAscii
        };
      }
      if (timelineMermaid !== void 0) {
        diagrams.timeline = {
          mermaid: timelineMermaid
        };
      }
      const response = {
        resource: resourceName,
        resourceType,
        diagrams,
        dependencyCount,
        eventCount,
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

// src/tools/advisor.ts
import { z as z17 } from "zod";
var IMPACT_ORDER = {
  High: 0,
  Medium: 1,
  Low: 2
};
function sortByImpact(a, b) {
  return (IMPACT_ORDER[a.impact] ?? 3) - (IMPACT_ORDER[b.impact] ?? 3);
}
function buildQuery(category, resourceGroup) {
  const lines = [
    "advisorresources",
    "| where type == 'microsoft.advisor/recommendations'"
  ];
  if (category !== "all") {
    lines.push(`| where properties.category =~ '${category}'`);
  }
  if (resourceGroup) {
    lines.push(`| where resourceGroup =~ '${resourceGroup}'`);
  }
  lines.push(
    "| project",
    "    id,",
    "    name,",
    "    resourceGroup,",
    "    category = properties.category,",
    "    impact = properties.impact,",
    "    impactedField = properties.impactedField,",
    "    impactedValue = properties.impactedValue,",
    "    shortDescription = properties.shortDescription.solution,",
    "    problem = properties.shortDescription.problem,",
    "    resourceId = properties.resourceMetadata.resourceId,",
    "    lastUpdated = properties.lastUpdated"
  );
  return lines.join("\n");
}
function parseRecommendations(resources) {
  return resources.map((r) => ({
    category: r["category"] ?? "Unknown",
    impact: r["impact"] ?? "Unknown",
    problem: r["problem"] ?? "",
    solution: r["shortDescription"] ?? "",
    affectedResource: r["impactedValue"] ?? "",
    affectedResourceType: r["impactedField"] ?? "",
    resourceGroup: r["resourceGroup"] ?? "",
    lastUpdated: r["lastUpdated"] ?? ""
  }));
}
function correlateWithInvestigation(recommendations, investigationContext) {
  let investigation;
  try {
    investigation = JSON.parse(investigationContext);
  } catch {
    return recommendations.map((rec) => ({ ...rec, correlated: false }));
  }
  const investigatedResources = /* @__PURE__ */ new Set();
  const investigationText = JSON.stringify(investigation).toLowerCase();
  const resourceId = investigation["resourceId"];
  if (resourceId) {
    investigatedResources.add(resourceId.toLowerCase());
    const segments = resourceId.split("/");
    const resourceName = segments[segments.length - 1];
    if (resourceName) investigatedResources.add(resourceName.toLowerCase());
  }
  const findings = investigation["findings"] ?? investigation["results"];
  if (Array.isArray(findings)) {
    for (const f of findings) {
      const res = f["resource"] ?? f["resourceId"] ?? f["resourceName"];
      if (res) {
        investigatedResources.add(res.toLowerCase());
        const parts = res.split("/");
        investigatedResources.add(parts[parts.length - 1].toLowerCase());
      }
    }
  }
  const dependencies = investigation["dependencies"];
  if (Array.isArray(dependencies)) {
    for (const dep of dependencies) {
      const depId = dep["resourceId"] ?? dep["name"];
      if (depId) {
        investigatedResources.add(depId.toLowerCase());
        const parts = depId.split("/");
        investigatedResources.add(parts[parts.length - 1].toLowerCase());
      }
    }
  }
  const hasAnomalies = investigationText.includes("anomal") || investigationText.includes("unhealthy") || investigationText.includes("degraded") || investigationText.includes("critical");
  return recommendations.map((rec) => {
    const recResourceLower = rec.affectedResource.toLowerCase();
    const recTypeLower = rec.affectedResourceType.toLowerCase();
    if (investigatedResources.has(recResourceLower) || [...investigatedResources].some(
      (ir) => ir.includes(recResourceLower) || recResourceLower.includes(ir)
    )) {
      return {
        ...rec,
        correlated: true,
        correlationNote: `Advisor recommendation directly targets resource "${rec.affectedResource}" which is part of the current investigation.`
      };
    }
    if (hasAnomalies && (rec.category.toLowerCase() === "reliability" || rec.category.toLowerCase() === "performance")) {
      if (investigationText.includes(recTypeLower) || investigationText.includes(recResourceLower)) {
        return {
          ...rec,
          correlated: true,
          correlationNote: `Investigation detected anomalies, and this ${rec.category} recommendation for "${rec.affectedResource}" may be related.`
        };
      }
    }
    if (rec.category.toLowerCase() === "cost" && Array.isArray(dependencies)) {
      const depNames = dependencies.map(
        (d) => (d["resourceId"] ?? d["name"] ?? "").toLowerCase()
      );
      if (depNames.some(
        (dn) => dn.includes(recResourceLower) || recResourceLower.includes(dn)
      )) {
        return {
          ...rec,
          correlated: true,
          correlationNote: `Cost recommendation for "${rec.affectedResource}" which is in the dependency chain of the investigated resource.`
        };
      }
    }
    return { ...rec, correlated: false };
  });
}
function buildTopActions(recommendations, count = 3) {
  const sorted = [...recommendations].sort((a, b) => {
    if (a.correlated && !b.correlated) return -1;
    if (!a.correlated && b.correlated) return 1;
    return sortByImpact(a, b);
  });
  return sorted.slice(0, count).map((rec) => {
    const resource = rec.affectedResource || "unknown resource";
    const detail = rec.solution || rec.problem || "Review recommendation";
    return `${rec.impact.toUpperCase()}: ${detail} for ${resource} (${rec.category})`;
  });
}
function registerAdvisor(server2) {
  server2.tool(
    "azdoctor_advisor",
    "Pull Azure Advisor recommendations for a subscription or resource. Correlates Advisor findings with live diagnostic data to prioritize actionable improvements across reliability, security, performance, cost, and operational excellence.",
    {
      subscription: z17.string().optional().describe("Azure subscription ID (auto-detected if omitted)"),
      resourceGroup: z17.string().optional().describe("Scope to a specific resource group"),
      category: z17.enum([
        "all",
        "reliability",
        "security",
        "performance",
        "cost",
        "operationalexcellence"
      ]).default("all").describe("Filter by Advisor recommendation category"),
      investigationContext: z17.string().optional().describe(
        "JSON output from a prior azdoctor_investigate call \u2014 correlates Advisor recs with live findings"
      )
    },
    async ({ subscription, resourceGroup, category, investigationContext }) => {
      const errors = [];
      let subscriptionId;
      try {
        subscriptionId = await resolveSubscription(subscription);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: err instanceof Error ? err.message : "Failed to resolve subscription"
                },
                null,
                2
              )
            }
          ]
        };
      }
      const query = buildQuery(category, resourceGroup);
      const graphResult = await queryResourceGraph([subscriptionId], query);
      if (graphResult.error) {
        errors.push(graphResult.error);
      }
      const rawRecommendations = parseRecommendations(graphResult.resources);
      rawRecommendations.sort(sortByImpact);
      let recommendations;
      if (investigationContext) {
        recommendations = correlateWithInvestigation(
          rawRecommendations,
          investigationContext
        );
      } else {
        recommendations = rawRecommendations.map((rec) => ({
          ...rec,
          correlated: false
        }));
      }
      const byCategory = {};
      const byImpact = {};
      for (const rec of recommendations) {
        byCategory[rec.category] = (byCategory[rec.category] ?? 0) + 1;
        byImpact[rec.impact] = (byImpact[rec.impact] ?? 0) + 1;
      }
      const correlatedCount = recommendations.filter((r) => r.correlated).length;
      const topActions = buildTopActions(recommendations);
      const summary = {
        subscription: subscriptionId,
        scope: resourceGroup ?? "subscription",
        totalRecommendations: recommendations.length,
        byCategory,
        byImpact,
        recommendations,
        correlatedCount,
        topActions,
        ...errors.length > 0 ? { errors } : {}
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2)
          }
        ]
      };
    }
  );
}

// src/tools/notify.ts
import { z as z18 } from "zod";
function detectWebhookType(url) {
  if (url.includes("webhook.office.com") || url.includes("microsoft.com")) return "teams";
  if (url.includes("hooks.slack.com")) return "slack";
  return "generic";
}
function formatTeamsMessage(title, message, severity) {
  return {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: severity === "critical" ? "FF0000" : severity === "warning" ? "FFA500" : "00FF00",
    summary: title,
    sections: [
      {
        activityTitle: title,
        activitySubtitle: `Severity: ${severity.toUpperCase()} | ${(/* @__PURE__ */ new Date()).toISOString()}`,
        text: message.length > 2e3 ? message.substring(0, 2e3) + "\n\n... (truncated)" : message,
        markdown: true
      }
    ]
  };
}
function formatSlackMessage(title, message, severity) {
  const emoji = severity === "critical" ? "\u{1F534}" : severity === "warning" ? "\u{1F7E1}" : "\u{1F7E2}";
  return {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${emoji} ${title}` }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: message.length > 3e3 ? message.substring(0, 3e3) + "\n\n... (truncated)" : message
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*Severity:* ${severity.toUpperCase()} | *Sent:* ${(/* @__PURE__ */ new Date()).toISOString()} | _via AZ Doctor_`
          }
        ]
      }
    ]
  };
}
function formatGenericMessage(title, message, severity) {
  return {
    title,
    severity,
    message,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    source: "azdoctor"
  };
}
async function sendWebhook(url, payload) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15e3)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { success: false, statusCode: response.status, error: `HTTP ${response.status}: ${text}` };
    }
    return { success: true, statusCode: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, statusCode: 0, error: message };
  }
}
function summarizeToolOutput(message) {
  try {
    const parsed = JSON.parse(message);
    const parts = [];
    if (parsed.resource) parts.push(`**Resource:** ${parsed.resource}`);
    if (parsed.currentHealth) parts.push(`**Health:** ${parsed.currentHealth}`);
    if (parsed.confidence) parts.push(`**Confidence:** ${parsed.confidence}`);
    if (parsed.likelyCause) parts.push(`**Likely Cause:** ${parsed.likelyCause}`);
    if (parsed.riskScore !== void 0) parts.push(`**Risk Score:** ${parsed.riskScore}/100`);
    if (parsed.diagnosticCoverage) parts.push(`**Coverage:** ${parsed.diagnosticCoverage}`);
    if (parsed.diagnosticInsights?.length > 0) {
      parts.push(`**Patterns Detected:** ${parsed.diagnosticInsights.map((i) => i.pattern).join(", ")}`);
    }
    if (parsed.recommendedActions?.length > 0) {
      parts.push(`**Next Steps:**`);
      for (const action of parsed.recommendedActions.slice(0, 3)) {
        parts.push(`- ${action}`);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  } catch {
  }
  return message;
}
function registerNotify(server2) {
  server2.tool(
    "azdoctor_notify",
    "Send investigation summaries or alerts to Teams, Slack, or any webhook endpoint. Useful for on-call handoffs and incident communication.",
    {
      webhookUrl: z18.string().describe("Webhook URL (Teams Incoming Webhook, Slack Incoming Webhook, or any HTTP endpoint)"),
      message: z18.string().describe("Message content or JSON output from an AZ Doctor tool to format and send"),
      title: z18.string().optional().describe("Message title/subject (default: 'AZ Doctor Alert')"),
      severity: z18.enum(["critical", "warning", "info"]).default("info").describe("Severity level \u2014 affects message color/formatting"),
      format: z18.enum(["auto", "teams", "slack", "generic"]).default("auto").describe("Message format. Auto-detects from webhook URL.")
    },
    async ({ webhookUrl, message, title, severity, format }) => {
      const resolvedTitle = title ?? "AZ Doctor Alert";
      const webhookType = format === "auto" ? detectWebhookType(webhookUrl) : format;
      const formattedMessage = summarizeToolOutput(message);
      let payload;
      switch (webhookType) {
        case "teams":
          payload = formatTeamsMessage(resolvedTitle, formattedMessage, severity);
          break;
        case "slack":
          payload = formatSlackMessage(resolvedTitle, formattedMessage, severity);
          break;
        default:
          payload = formatGenericMessage(resolvedTitle, formattedMessage, severity);
          break;
      }
      const result = await sendWebhook(webhookUrl, payload);
      const messageSummary = formattedMessage.substring(0, 100) + (formattedMessage.length > 100 ? "..." : "");
      const response = {
        sent: result.success,
        webhookType,
        statusCode: result.statusCode,
        ...result.error && { error: result.error },
        messageSummary
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2)
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
registerCompare(server);
registerRemediate(server);
registerQueryTool(server);
registerCost(server);
registerPlayback(server);
registerAlertRules(server);
registerSweep(server);
registerBaseline(server);
registerJournal(server);
registerPlaybooks(server);
registerTriage(server);
registerDiagram(server);
registerAdvisor(server);
registerNotify(server);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((error) => {
  console.error("AZ Doctor MCP server failed to start:", error);
  process.exit(1);
});
