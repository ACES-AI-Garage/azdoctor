import { execSync } from "node:child_process";
import { DefaultAzureCredential } from "@azure/identity";
import { ResourceGraphClient, } from "@azure/arm-resourcegraph";
import { MicrosoftResourceHealth } from "@azure/arm-resourcehealth";
import { MonitorClient } from "@azure/arm-monitor";
import { LogsQueryClient, MetricsQueryClient } from "@azure/monitor-query";
import { MicrosoftSupport } from "@azure/arm-support";
// ─── Shared credential ──────────────────────────────────────────────
let credentialInstance = null;
export function getCredential() {
    if (!credentialInstance) {
        credentialInstance = new DefaultAzureCredential();
    }
    return credentialInstance;
}
// ─── Subscription resolution ─────────────────────────────────────────
let cachedSubscription = null;
/**
 * Resolve the Azure subscription ID from multiple sources:
 * 1. Explicit parameter (if provided)
 * 2. AZURE_SUBSCRIPTION_ID environment variable
 * 3. Default subscription from `az account show`
 */
export async function resolveSubscription(explicit) {
    if (explicit)
        return explicit;
    if (cachedSubscription)
        return cachedSubscription;
    // Check env var
    const envSub = process.env.AZURE_SUBSCRIPTION_ID;
    if (envSub) {
        cachedSubscription = envSub;
        return envSub;
    }
    // Fall back to az CLI default subscription
    try {
        const output = execSync("az account show --query id -o tsv", {
            encoding: "utf-8",
            timeout: 10000,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (output) {
            cachedSubscription = output;
            return output;
        }
    }
    catch {
        // az CLI not available or not logged in
    }
    throw new Error("No subscription ID found. Provide one explicitly, set AZURE_SUBSCRIPTION_ID, or run 'az login'.");
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
            roleRecommendation: getRoleRecommendation(context),
        };
    }
    if (statusCode === 429 || code === "TooManyRequests") {
        return {
            code: "THROTTLED",
            message: `Rate-limited on ${context}: ${message}`,
        };
    }
    return { code, message: `${context} failed: ${message}` };
}
function getRoleRecommendation(context) {
    const recommendations = {
        resourceHealth: "Assign Reader role on the subscription or resource.",
        activityLog: "Assign Reader role (includes Microsoft.Insights/eventtypes/*).",
        resourceGraph: "Assign Reader role — Resource Graph returns only resources the identity can read.",
        metrics: "Assign Reader role on the target resource.",
        logAnalytics: "Assign Log Analytics Reader on the workspace, or ensure workspace access mode allows resource-context queries.",
        support: "Assign Support Request Contributor role (requires paid support plan: Pro Direct/Premier/Unified).",
    };
    return recommendations[context] ?? "Check your RBAC role assignments on the target scope.";
}
// ─── Retry helper ────────────────────────────────────────────────────
async function withRetry(fn, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastError = err;
            const e = err;
            if (e.statusCode === 429 && attempt < maxRetries) {
                const delayMs = Math.min(1000 * 2 ** attempt, 16000);
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
            }
            throw err;
        }
    }
    throw lastError;
}
// ─── Client factories ────────────────────────────────────────────────
export function createResourceGraphClient() {
    return new ResourceGraphClient(getCredential());
}
export function createResourceHealthClient(subscriptionId) {
    return new MicrosoftResourceHealth(getCredential(), subscriptionId);
}
export function createMonitorClient(subscriptionId) {
    return new MonitorClient(getCredential(), subscriptionId);
}
export function createLogsQueryClient() {
    return new LogsQueryClient(getCredential());
}
export function createMetricsQueryClient() {
    return new MetricsQueryClient(getCredential());
}
export function createSupportClient(subscriptionId) {
    return new MicrosoftSupport(getCredential(), subscriptionId);
}
const resourceGraphCache = new Map();
const RESOURCE_GRAPH_CACHE_TTL_MS = 60_000; // 60 seconds
export function clearResourceGraphCache() {
    resourceGraphCache.clear();
}
export async function queryResourceGraph(subscriptions, query, skipCache = false) {
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
            options: { resultFormat: "objectArray" },
        };
        const response = await withRetry(() => client.resources(request));
        const allData = response.data ?? [];
        const totalRecords = response.totalRecords ?? allData.length;
        // Paginate if there are more results (safety limit: 10 pages)
        const MAX_PAGES = 10;
        let skipToken = response.skipToken;
        let page = 1;
        while (skipToken && page < MAX_PAGES) {
            const pagedRequest = {
                subscriptions,
                query,
                options: { resultFormat: "objectArray", skipToken },
            };
            const pagedResponse = await withRetry(() => client.resources(pagedRequest));
            const pageData = pagedResponse.data ?? [];
            allData.push(...pageData);
            skipToken = pagedResponse.skipToken;
            page++;
        }
        const result = {
            resources: allData,
            totalRecords,
        };
        resourceGraphCache.set(cacheKey, {
            result,
            expiry: Date.now() + RESOURCE_GRAPH_CACHE_TTL_MS,
        });
        return result;
    }
    catch (err) {
        return { resources: [], totalRecords: 0, error: classifyError(err, "resourceGraph") };
    }
}
export async function getResourceDiagnosticSettings(subscriptionId, resourceUri) {
    try {
        const client = createMonitorClient(subscriptionId);
        const response = await withRetry(() => client.diagnosticSettings.list(resourceUri));
        const settings = (response.value ?? []).map((setting) => ({
            name: setting.name ?? "",
            workspaceId: setting.workspaceId ?? "",
            // Note: The workspace GUID (customerId) cannot be obtained from diagnostic
            // settings alone — it would require a separate call to the workspace resource.
            workspaceCustomerId: undefined,
            logs: (setting.logs ?? [])
                .filter((log) => log.enabled)
                .map((log) => log.category ?? ""),
            metrics: (setting.metrics ?? []).some((m) => m.enabled),
        }));
        return { settings };
    }
    catch (err) {
        return { settings: [], error: classifyError(err, "diagnosticSettings") };
    }
}
export async function getResourceHealth(subscriptionId, resourceUri) {
    try {
        const client = createResourceHealthClient(subscriptionId);
        const status = await withRetry(() => client.availabilityStatuses.getByResource(resourceUri));
        return { statuses: [status] };
    }
    catch (err) {
        return { statuses: [], error: classifyError(err, "resourceHealth") };
    }
}
export async function batchResourceHealth(subscriptionId, resourceGroup) {
    try {
        const client = createResourceHealthClient(subscriptionId);
        const statuses = [];
        const iter = resourceGroup
            ? client.availabilityStatuses.listByResourceGroup(resourceGroup)
            : client.availabilityStatuses.listBySubscriptionId();
        for await (const status of iter) {
            statuses.push(status);
        }
        return { statuses };
    }
    catch (err) {
        return { statuses: [], error: classifyError(err, "resourceHealth") };
    }
}
export async function getActivityLogs(subscriptionId, hoursBack = 24, resourceUri, resourceGroup, maxEvents = 1000) {
    try {
        const client = createMonitorClient(subscriptionId);
        const now = new Date();
        const start = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
        let filter = `eventTimestamp ge '${start.toISOString()}' and eventTimestamp le '${now.toISOString()}'`;
        if (resourceUri) {
            filter += ` and resourceUri eq '${resourceUri}'`;
        }
        else if (resourceGroup) {
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
    }
    catch (err) {
        return { events: [], error: classifyError(err, "activityLog") };
    }
}
export async function getMetrics(resourceUri, metricNames, timespanHours = 24, granularity = "PT1H") {
    try {
        const client = createMetricsQueryClient();
        const now = new Date();
        const start = new Date(now.getTime() - timespanHours * 60 * 60 * 1000);
        const timespan = { startTime: start, endTime: now };
        const result = await withRetry(() => client.queryResource(resourceUri, metricNames, {
            timespan,
            granularity,
            aggregations: ["Average", "Maximum"],
        }));
        return { data: result };
    }
    catch (err) {
        return { data: null, error: classifyError(err, "metrics") };
    }
}
export async function queryLogAnalytics(workspaceId, query, timespanHours = 24) {
    try {
        const client = createLogsQueryClient();
        const now = new Date();
        const start = new Date(now.getTime() - timespanHours * 60 * 60 * 1000);
        const timespan = { startTime: start, endTime: now };
        const result = await withRetry(() => client.queryWorkspace(workspaceId, query, timespan));
        if (result.status === "PartialFailure") {
            const tables = result.partialTables.map((t) => ({
                name: t.name,
                columns: t.columnDescriptors.map((c) => c.name ?? ""),
                rows: t.rows ?? [],
            }));
            return { tables };
        }
        const tables = result.tables.map((t) => ({
            name: t.name,
            columns: t.columnDescriptors.map((c) => c.name ?? ""),
            rows: t.rows ?? [],
        }));
        return { tables };
    }
    catch (err) {
        return { tables: [], error: classifyError(err, "logAnalytics") };
    }
}
export async function discoverWorkspaces(subscriptionId, resourceGroup) {
    let query = "Resources | where type =~ 'Microsoft.OperationalInsights/workspaces' | project id, name, properties.customerId";
    if (resourceGroup) {
        query =
            `Resources | where type =~ 'Microsoft.OperationalInsights/workspaces' | where resourceGroup =~ '${resourceGroup}' | project id, name, properties.customerId`;
    }
    const result = await queryResourceGraph([subscriptionId], query);
    if (result.error) {
        return { workspaces: [], error: result.error };
    }
    const workspaces = result.resources.map((r) => ({
        workspaceId: r["properties_customerId"] ?? "",
        workspaceName: r["name"] ?? "",
        resourceId: r["id"] ?? "",
    }));
    return { workspaces };
}
// ─── Concurrency Limiter ────────────────────────────────────────────
export async function batchExecute(tasks, batchSize = 5) {
    const results = [];
    for (let i = 0; i < tasks.length; i += batchSize) {
        const batch = tasks.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map((fn) => fn()));
        results.push(...batchResults);
    }
    return results;
}
//# sourceMappingURL=azure-client.js.map