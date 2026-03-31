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
export async function queryResourceGraph(subscriptions, query) {
    try {
        const client = createResourceGraphClient();
        const request = {
            subscriptions,
            query,
            options: { resultFormat: "objectArray" },
        };
        const response = await withRetry(() => client.resources(request));
        const data = response.data ?? [];
        return { resources: data, totalRecords: response.totalRecords ?? data.length };
    }
    catch (err) {
        return { resources: [], totalRecords: 0, error: classifyError(err, "resourceGraph") };
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
export async function getActivityLogs(subscriptionId, hoursBack = 24, resourceUri, resourceGroup) {
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
/**
 * Query the SQL Query Store for top resource-consuming queries.
 * Uses Azure AD token authentication via DefaultAzureCredential.
 */
export async function querySqlQueryStore(serverFqdn, databaseName, timespanHours = 24, topN = 10) {
    try {
        const { Connection, Request, TYPES } = await import("tedious");
        // Get AAD token for Azure SQL
        const credential = getCredential();
        const tokenResponse = await credential.getToken("https://database.windows.net/.default");
        if (!tokenResponse?.token) {
            return {
                topQueries: [],
                error: {
                    code: "AUTH_FAILED",
                    message: "querySqlQueryStore: Failed to acquire Azure AD token for SQL Database",
                },
            };
        }
        const topQueries = await new Promise((resolve, reject) => {
            const config = {
                server: serverFqdn,
                authentication: {
                    type: "azure-active-directory-access-token",
                    options: { token: tokenResponse.token },
                },
                options: {
                    database: databaseName,
                    encrypt: true,
                    port: 1433,
                    connectTimeout: 15000,
                    requestTimeout: 30000,
                },
            };
            const connection = new Connection(config);
            const rows = [];
            connection.on("connect", (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                const sql = `
            SELECT TOP (${topN})
              qs.query_id,
              SUBSTRING(qt.query_sql_text, 1, 500) AS query_sql_text,
              SUM(rs.count_executions) AS count_executions,
              AVG(rs.avg_duration / 1000000.0) AS avg_duration_sec,
              MAX(rs.max_duration / 1000000.0) AS max_duration_sec,
              AVG(rs.avg_cpu_time / 1000000.0) AS avg_cpu_sec,
              MAX(rs.max_cpu_time / 1000000.0) AS max_cpu_sec,
              AVG(rs.avg_logical_io_reads) AS avg_logical_io_reads,
              AVG(rs.avg_logical_io_writes) AS avg_logical_io_writes,
              MAX(rs.last_execution_time) AS last_execution_time
            FROM sys.query_store_query qs
            JOIN sys.query_store_query_text qt ON qs.query_text_id = qt.query_text_id
            JOIN sys.query_store_plan qp ON qs.query_id = qp.query_id
            JOIN sys.query_store_runtime_stats rs ON qp.plan_id = rs.plan_id
            WHERE rs.last_execution_time > DATEADD(HOUR, -${timespanHours}, GETUTCDATE())
            GROUP BY qs.query_id, SUBSTRING(qt.query_sql_text, 1, 500)
            ORDER BY MAX(rs.max_cpu_time) DESC
          `;
                const request = new Request(sql, (reqErr) => {
                    connection.close();
                    if (reqErr) {
                        reject(reqErr);
                    }
                    else {
                        resolve(rows);
                    }
                });
                request.on("row", (columns) => {
                    const row = {};
                    for (const col of columns) {
                        row[col.metadata.colName] = col.value;
                    }
                    rows.push({
                        queryId: row["query_id"],
                        querySqlText: row["query_sql_text"] ?? "",
                        executionCount: row["count_executions"],
                        avgDurationSec: Math.round((row["avg_duration_sec"] ?? 0) * 1000) / 1000,
                        maxDurationSec: Math.round((row["max_duration_sec"] ?? 0) * 1000) / 1000,
                        avgCpuSec: Math.round((row["avg_cpu_sec"] ?? 0) * 1000) / 1000,
                        maxCpuSec: Math.round((row["max_cpu_sec"] ?? 0) * 1000) / 1000,
                        avgLogicalIoReads: Math.round(row["avg_logical_io_reads"] ?? 0),
                        avgLogicalIoWrites: Math.round(row["avg_logical_io_writes"] ?? 0),
                        lastExecutionTime: row["last_execution_time"]?.toString() ?? "",
                    });
                });
                connection.execSql(request);
            });
            connection.connect();
        });
        return { topQueries };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            topQueries: [],
            error: {
                code: "QUERY_STORE_ERROR",
                message: `querySqlQueryStore failed: ${message}`,
                roleRecommendation: "Ensure Azure AD admin is set on the SQL server, and the identity has VIEW DATABASE STATE permission.",
            },
        };
    }
}
//# sourceMappingURL=azure-client.js.map