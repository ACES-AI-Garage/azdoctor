import { execSync } from "node:child_process";
import { DefaultAzureCredential } from "@azure/identity";
import type { TokenCredential } from "@azure/identity";
import {
  ResourceGraphClient,
  ResourceGraphModels,
} from "@azure/arm-resourcegraph";
import { MicrosoftResourceHealth } from "@azure/arm-resourcehealth";
import type { AvailabilityStatus } from "@azure/arm-resourcehealth";
import { MonitorClient } from "@azure/arm-monitor";
import type { EventData } from "@azure/arm-monitor";
import { LogsQueryClient, MetricsQueryClient } from "@azure/monitor-query";
import type { MetricsQueryResult } from "@azure/monitor-query";
import { MicrosoftSupport } from "@azure/arm-support";

// ─── Shared credential ──────────────────────────────────────────────

let credentialInstance: TokenCredential | null = null;

export function getCredential(): TokenCredential {
  if (!credentialInstance) {
    credentialInstance = new DefaultAzureCredential();
  }
  return credentialInstance;
}

// ─── Subscription resolution ─────────────────────────────────────────

let cachedSubscription: string | null = null;

/**
 * Resolve the Azure subscription ID from multiple sources:
 * 1. Explicit parameter (if provided)
 * 2. AZURE_SUBSCRIPTION_ID environment variable
 * 3. Default subscription from `az account show`
 */
export async function resolveSubscription(
  explicit?: string
): Promise<string> {
  if (explicit) return explicit;

  if (cachedSubscription) return cachedSubscription;

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
  } catch {
    // az CLI not available or not logged in
  }

  throw new Error(
    "No subscription ID found. Provide one explicitly, set AZURE_SUBSCRIPTION_ID, or run 'az login'."
  );
}

// ─── Error handling ──────────────────────────────────────────────────

export interface AzureError {
  code: string;
  message: string;
  roleRecommendation?: string;
}

function classifyError(err: unknown, context: string): AzureError {
  const e = err as { statusCode?: number; code?: string; message?: string };
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

function getRoleRecommendation(context: string): string {
  const recommendations: Record<string, string> = {
    resourceHealth: "Assign Reader role on the subscription or resource.",
    activityLog: "Assign Reader role (includes Microsoft.Insights/eventtypes/*).",
    resourceGraph: "Assign Reader role — Resource Graph returns only resources the identity can read.",
    metrics: "Assign Reader role on the target resource.",
    logAnalytics:
      "Assign Log Analytics Reader on the workspace, or ensure workspace access mode allows resource-context queries.",
    support: "Assign Support Request Contributor role (requires paid support plan: Pro Direct/Premier/Unified).",
  };
  return recommendations[context] ?? "Check your RBAC role assignments on the target scope.";
}

// ─── Retry helper ────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const e = err as { statusCode?: number };
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

export function createResourceGraphClient(): ResourceGraphClient {
  return new ResourceGraphClient(getCredential());
}

export function createResourceHealthClient(
  subscriptionId: string
): MicrosoftResourceHealth {
  return new MicrosoftResourceHealth(getCredential(), subscriptionId);
}

export function createMonitorClient(subscriptionId: string): MonitorClient {
  return new MonitorClient(getCredential(), subscriptionId);
}

export function createLogsQueryClient(): LogsQueryClient {
  return new LogsQueryClient(getCredential());
}

export function createMetricsQueryClient(): MetricsQueryClient {
  return new MetricsQueryClient(getCredential());
}

export function createSupportClient(subscriptionId: string): MicrosoftSupport {
  return new MicrosoftSupport(getCredential(), subscriptionId);
}

// ─── Resource Graph ──────────────────────────────────────────────────

export interface ResourceGraphResult {
  resources: Record<string, unknown>[];
  totalRecords: number;
  error?: AzureError;
}

export async function queryResourceGraph(
  subscriptions: string[],
  query: string
): Promise<ResourceGraphResult> {
  try {
    const client = createResourceGraphClient();
    const request: ResourceGraphModels.QueryRequest = {
      subscriptions,
      query,
      options: { resultFormat: "objectArray" },
    };
    const response = await withRetry(() => client.resources(request));
    const data = (response.data as Record<string, unknown>[]) ?? [];
    return { resources: data, totalRecords: response.totalRecords ?? data.length };
  } catch (err) {
    return { resources: [], totalRecords: 0, error: classifyError(err, "resourceGraph") };
  }
}

// ─── Resource Health ─────────────────────────────────────────────────

export interface HealthResult {
  statuses: AvailabilityStatus[];
  error?: AzureError;
}

export async function getResourceHealth(
  subscriptionId: string,
  resourceUri: string
): Promise<HealthResult> {
  try {
    const client = createResourceHealthClient(subscriptionId);
    const status = await withRetry(() =>
      client.availabilityStatuses.getByResource(resourceUri)
    );
    return { statuses: [status] };
  } catch (err) {
    return { statuses: [], error: classifyError(err, "resourceHealth") };
  }
}

export async function batchResourceHealth(
  subscriptionId: string,
  resourceGroup?: string
): Promise<HealthResult> {
  try {
    const client = createResourceHealthClient(subscriptionId);
    const statuses: AvailabilityStatus[] = [];

    const iter = resourceGroup
      ? client.availabilityStatuses.listByResourceGroup(resourceGroup)
      : client.availabilityStatuses.listBySubscriptionId();

    for await (const status of iter) {
      statuses.push(status);
    }
    return { statuses };
  } catch (err) {
    return { statuses: [], error: classifyError(err, "resourceHealth") };
  }
}

// ─── Activity Logs ───────────────────────────────────────────────────

export interface ActivityLogResult {
  events: EventData[];
  error?: AzureError;
}

export async function getActivityLogs(
  subscriptionId: string,
  hoursBack: number = 24,
  resourceUri?: string,
  resourceGroup?: string
): Promise<ActivityLogResult> {
  try {
    const client = createMonitorClient(subscriptionId);
    const now = new Date();
    const start = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);

    let filter = `eventTimestamp ge '${start.toISOString()}' and eventTimestamp le '${now.toISOString()}'`;
    if (resourceUri) {
      filter += ` and resourceUri eq '${resourceUri}'`;
    } else if (resourceGroup) {
      filter += ` and resourceGroupName eq '${resourceGroup}'`;
    }

    const events: EventData[] = [];
    for await (const event of client.activityLogs.list(filter)) {
      events.push(event);
    }
    return { events };
  } catch (err) {
    return { events: [], error: classifyError(err, "activityLog") };
  }
}

// ─── Metrics ─────────────────────────────────────────────────────────

export interface MetricsResult {
  data: MetricsQueryResult | null;
  error?: AzureError;
}

export async function getMetrics(
  resourceUri: string,
  metricNames: string[],
  timespanHours: number = 24,
  granularity: string = "PT1H"
): Promise<MetricsResult> {
  try {
    const client = createMetricsQueryClient();
    const now = new Date();
    const start = new Date(now.getTime() - timespanHours * 60 * 60 * 1000);
    const timespan = { startTime: start, endTime: now };

    const result = await withRetry(() =>
      client.queryResource(resourceUri, metricNames, {
        timespan,
        granularity,
        aggregations: ["Average", "Maximum"],
      })
    );
    return { data: result };
  } catch (err) {
    return { data: null, error: classifyError(err, "metrics") };
  }
}

// ─── Log Analytics ───────────────────────────────────────────────────

export interface LogAnalyticsResult {
  tables: Array<{ name: string; columns: string[]; rows: unknown[][] }>;
  error?: AzureError;
}

export async function queryLogAnalytics(
  workspaceId: string,
  query: string,
  timespanHours: number = 24
): Promise<LogAnalyticsResult> {
  try {
    const client = createLogsQueryClient();
    const now = new Date();
    const start = new Date(now.getTime() - timespanHours * 60 * 60 * 1000);
    const timespan = { startTime: start, endTime: now };

    const result = await withRetry(() =>
      client.queryWorkspace(workspaceId, query, timespan)
    );

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
  } catch (err) {
    return { tables: [], error: classifyError(err, "logAnalytics") };
  }
}

// ─── SQL Query Store (Azure SQL DB) ─────────────────────────────────

export interface QueryStoreInsight {
  queryId: number;
  querySqlText: string;
  executionCount: number;
  avgDurationSec: number;
  maxDurationSec: number;
  avgCpuSec: number;
  maxCpuSec: number;
  avgLogicalIoReads: number;
  avgLogicalIoWrites: number;
  lastExecutionTime: string;
}

export interface QueryStoreResult {
  topQueries: QueryStoreInsight[];
  error?: AzureError;
}

/**
 * Query the SQL Query Store for top resource-consuming queries.
 * Uses Azure AD token authentication via DefaultAzureCredential.
 */
export async function querySqlQueryStore(
  serverFqdn: string,
  databaseName: string,
  timespanHours: number = 24,
  topN: number = 10
): Promise<QueryStoreResult> {
  try {
    const { Connection, Request, TYPES } = await import("tedious");

    // Get AAD token for Azure SQL
    const credential = getCredential();
    const tokenResponse = await credential.getToken(
      "https://database.windows.net/.default"
    );
    if (!tokenResponse?.token) {
      return {
        topQueries: [],
        error: {
          code: "AUTH_FAILED",
          message: "querySqlQueryStore: Failed to acquire Azure AD token for SQL Database",
        },
      };
    }

    const topQueries = await new Promise<QueryStoreInsight[]>(
      (resolve, reject) => {
        const config = {
          server: serverFqdn,
          authentication: {
            type: "azure-active-directory-access-token" as const,
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
        const rows: QueryStoreInsight[] = [];

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
            } else {
              resolve(rows);
            }
          });

          request.on("row", (columns: Array<{ metadata: { colName: string }; value: unknown }>) => {
            const row: Record<string, unknown> = {};
            for (const col of columns) {
              row[col.metadata.colName] = col.value;
            }
            rows.push({
              queryId: row["query_id"] as number,
              querySqlText: (row["query_sql_text"] as string) ?? "",
              executionCount: row["count_executions"] as number,
              avgDurationSec: Math.round(((row["avg_duration_sec"] as number) ?? 0) * 1000) / 1000,
              maxDurationSec: Math.round(((row["max_duration_sec"] as number) ?? 0) * 1000) / 1000,
              avgCpuSec: Math.round(((row["avg_cpu_sec"] as number) ?? 0) * 1000) / 1000,
              maxCpuSec: Math.round(((row["max_cpu_sec"] as number) ?? 0) * 1000) / 1000,
              avgLogicalIoReads: Math.round((row["avg_logical_io_reads"] as number) ?? 0),
              avgLogicalIoWrites: Math.round((row["avg_logical_io_writes"] as number) ?? 0),
              lastExecutionTime: row["last_execution_time"]?.toString() ?? "",
            });
          });

          connection.execSql(request);
        });

        connection.connect();
      }
    );

    return { topQueries };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    return {
      topQueries: [],
      error: {
        code: "QUERY_STORE_ERROR",
        message: `querySqlQueryStore failed: ${message}`,
        roleRecommendation:
          "Ensure Azure AD admin is set on the SQL server, and the identity has VIEW DATABASE STATE permission.",
      },
    };
  }
}
