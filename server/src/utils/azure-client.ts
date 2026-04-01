import { execSync } from "node:child_process";

// Lazy-load Azure SDK modules to keep MCP server startup fast.
// These are only imported when a tool is actually invoked.
type TokenCredential = import("@azure/identity").TokenCredential;
type ResourceGraphClient = import("@azure/arm-resourcegraph").ResourceGraphClient;
type QueryRequest = import("@azure/arm-resourcegraph").ResourceGraphModels.QueryRequest;
type MicrosoftResourceHealth = import("@azure/arm-resourcehealth").MicrosoftResourceHealth;
type AvailabilityStatus = import("@azure/arm-resourcehealth").AvailabilityStatus;
type MonitorClient = import("@azure/arm-monitor").MonitorClient;
type EventData = import("@azure/arm-monitor").EventData;
type LogsQueryClient = import("@azure/monitor-query").LogsQueryClient;
type MetricsQueryClient = import("@azure/monitor-query").MetricsQueryClient;
type MetricsQueryResult = import("@azure/monitor-query").MetricsQueryResult;
type MicrosoftSupport = import("@azure/arm-support").MicrosoftSupport;
type ComputeManagementClient = import("@azure/arm-compute").ComputeManagementClient;

// ─── Shared credential ──────────────────────────────────────────────

let credentialInstance: TokenCredential | null = null;

export async function getCredential(): Promise<TokenCredential> {
  if (!credentialInstance) {
    const { DefaultAzureCredential } = await import("@azure/identity");
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

export async function createResourceGraphClient(): Promise<ResourceGraphClient> {
  const { ResourceGraphClient } = await import("@azure/arm-resourcegraph");
  return new ResourceGraphClient(await getCredential());
}

export async function createResourceHealthClient(
  subscriptionId: string
): Promise<MicrosoftResourceHealth> {
  const { MicrosoftResourceHealth } = await import("@azure/arm-resourcehealth");
  return new MicrosoftResourceHealth(await getCredential(), subscriptionId);
}

export async function createMonitorClient(subscriptionId: string): Promise<MonitorClient> {
  const { MonitorClient } = await import("@azure/arm-monitor");
  return new MonitorClient(await getCredential(), subscriptionId);
}

export async function createLogsQueryClient(): Promise<LogsQueryClient> {
  const { LogsQueryClient } = await import("@azure/monitor-query");
  return new LogsQueryClient(await getCredential());
}

export async function createMetricsQueryClient(): Promise<MetricsQueryClient> {
  const { MetricsQueryClient } = await import("@azure/monitor-query");
  return new MetricsQueryClient(await getCredential());
}

export async function createSupportClient(subscriptionId: string): Promise<MicrosoftSupport> {
  const { MicrosoftSupport } = await import("@azure/arm-support");
  return new MicrosoftSupport(await getCredential(), subscriptionId);
}

export async function createComputeClient(subscriptionId: string): Promise<ComputeManagementClient> {
  const { ComputeManagementClient } = await import("@azure/arm-compute");
  return new ComputeManagementClient(await getCredential(), subscriptionId);
}

// ─── Resource Graph ──────────────────────────────────────────────────

export interface ResourceGraphResult {
  resources: Record<string, unknown>[];
  totalRecords: number;
  error?: AzureError;
}

const resourceGraphCache = new Map<
  string,
  { result: ResourceGraphResult; expiry: number }
>();

const RESOURCE_GRAPH_CACHE_TTL_MS = 60_000; // 60 seconds

export function clearResourceGraphCache(): void {
  resourceGraphCache.clear();
}

export async function queryResourceGraph(
  subscriptions: string[],
  query: string,
  skipCache: boolean = false
): Promise<ResourceGraphResult> {
  const cacheKey = JSON.stringify({ subscriptions, query });

  if (!skipCache) {
    const cached = resourceGraphCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      return cached.result;
    }
  }

  try {
    const client = await createResourceGraphClient();
    const request: QueryRequest = {
      subscriptions,
      query,
      options: { resultFormat: "objectArray" },
    };
    const response = await withRetry(() => client.resources(request));
    const allData = (response.data as Record<string, unknown>[]) ?? [];
    const totalRecords = response.totalRecords ?? allData.length;

    // Paginate if there are more results (safety limit: 10 pages)
    const MAX_PAGES = 10;
    let skipToken = response.skipToken;
    let page = 1;
    while (skipToken && page < MAX_PAGES) {
      const pagedRequest: QueryRequest = {
        subscriptions,
        query,
        options: { resultFormat: "objectArray", skipToken },
      };
      const pagedResponse = await withRetry(() =>
        client.resources(pagedRequest)
      );
      const pageData =
        (pagedResponse.data as Record<string, unknown>[]) ?? [];
      allData.push(...pageData);
      skipToken = pagedResponse.skipToken;
      page++;
    }

    const result: ResourceGraphResult = {
      resources: allData,
      totalRecords,
    };

    resourceGraphCache.set(cacheKey, {
      result,
      expiry: Date.now() + RESOURCE_GRAPH_CACHE_TTL_MS,
    });

    return result;
  } catch (err) {
    return { resources: [], totalRecords: 0, error: classifyError(err, "resourceGraph") };
  }
}

// ─── Diagnostic Settings Discovery ──────────────────────────────────

export interface DiagnosticSettingInfo {
  name: string;
  workspaceId: string;      // The workspace resource ID
  workspaceCustomerId?: string; // The workspace GUID (for queries)
  logs: string[];           // Which log categories are enabled
  metrics: boolean;         // Whether metrics are sent
}

export async function getResourceDiagnosticSettings(
  subscriptionId: string,
  resourceUri: string
): Promise<{ settings: DiagnosticSettingInfo[]; error?: AzureError }> {
  try {
    const client = await createMonitorClient(subscriptionId);
    const response = await withRetry(() =>
      client.diagnosticSettings.list(resourceUri)
    );

    const settings: DiagnosticSettingInfo[] = (response.value ?? []).map(
      (setting) => ({
        name: setting.name ?? "",
        workspaceId: setting.workspaceId ?? "",
        // Note: The workspace GUID (customerId) cannot be obtained from diagnostic
        // settings alone — it would require a separate call to the workspace resource.
        workspaceCustomerId: undefined,
        logs: (setting.logs ?? [])
          .filter((log) => log.enabled)
          .map((log) => log.category ?? ""),
        metrics: (setting.metrics ?? []).some((m) => m.enabled),
      })
    );

    return { settings };
  } catch (err) {
    return { settings: [], error: classifyError(err, "diagnosticSettings") };
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
    const client = await createResourceHealthClient(subscriptionId);
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
    const client = await createResourceHealthClient(subscriptionId);
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
  resourceGroup?: string,
  maxEvents: number = 1000
): Promise<ActivityLogResult> {
  try {
    const client = await createMonitorClient(subscriptionId);
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
      if (events.length >= maxEvents) {
        break;
      }
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
    const client = await createMetricsQueryClient();
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

// ─── Metric Definitions ─────────────────────────────────────────────

export interface MetricDefinition {
  name: string;
  unit: string;
  aggregations: string[];
}

export async function listMetricDefinitions(
  resourceUri: string
): Promise<{ definitions: MetricDefinition[]; error?: AzureError }> {
  try {
    const client = await createMetricsQueryClient();
    const defs: MetricDefinition[] = [];
    for await (const def of client.listMetricDefinitions(resourceUri)) {
      if (def.name) {
        defs.push({
          name: def.name,
          unit: def.unit ?? "Unspecified",
          aggregations: def.supportedAggregationTypes ?? [],
        });
      }
    }
    return { definitions: defs };
  } catch (err) {
    return { definitions: [], error: classifyError(err, "metrics") };
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
    const client = await createLogsQueryClient();
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

// ─── Log Analytics Workspace Discovery ──────────────────────────────

export interface WorkspaceInfo {
  workspaceId: string;
  workspaceName: string;
  resourceId: string;
}

export async function discoverWorkspaces(
  subscriptionId: string,
  resourceGroup?: string
): Promise<{ workspaces: WorkspaceInfo[]; error?: AzureError }> {
  let query =
    "Resources | where type =~ 'Microsoft.OperationalInsights/workspaces' | project id, name, properties.customerId";

  if (resourceGroup) {
    query =
      `Resources | where type =~ 'Microsoft.OperationalInsights/workspaces' | where resourceGroup =~ '${resourceGroup}' | project id, name, properties.customerId`;
  }

  const result = await queryResourceGraph([subscriptionId], query);

  if (result.error) {
    return { workspaces: [], error: result.error };
  }

  const workspaces: WorkspaceInfo[] = result.resources.map((r) => ({
    workspaceId: (r["properties_customerId"] as string) ?? "",
    workspaceName: (r["name"] as string) ?? "",
    resourceId: (r["id"] as string) ?? "",
  }));

  return { workspaces };
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

export async function querySqlQueryStore(
  serverFqdn: string,
  databaseName: string,
  timespanHours: number = 24,
  topN: number = 10
): Promise<QueryStoreResult> {
  try {
    const { Connection, Request } = await import("tedious");
    const credential = await getCredential();
    const tokenResponse = await credential.getToken("https://database.windows.net/.default");
    if (!tokenResponse?.token) {
      return { topQueries: [], error: { code: "AUTH_FAILED", message: "Failed to acquire Azure AD token for SQL Database" } };
    }

    const topQueries = await new Promise<QueryStoreInsight[]>((resolve, reject) => {
      const connection = new Connection({
        server: serverFqdn,
        authentication: { type: "azure-active-directory-access-token" as const, options: { token: tokenResponse.token } },
        options: { database: databaseName, encrypt: true, port: 1433, connectTimeout: 15000, requestTimeout: 30000 },
      });
      const rows: QueryStoreInsight[] = [];

      connection.on("connect", (err) => {
        if (err) { reject(err); return; }
        const sql = `SELECT TOP (${topN})
          qs.query_id, SUBSTRING(qt.query_sql_text, 1, 500) AS query_sql_text,
          SUM(rs.count_executions) AS count_executions,
          AVG(rs.avg_duration / 1000000.0) AS avg_duration_sec, MAX(rs.max_duration / 1000000.0) AS max_duration_sec,
          AVG(rs.avg_cpu_time / 1000000.0) AS avg_cpu_sec, MAX(rs.max_cpu_time / 1000000.0) AS max_cpu_sec,
          AVG(rs.avg_logical_io_reads) AS avg_logical_io_reads, AVG(rs.avg_logical_io_writes) AS avg_logical_io_writes,
          MAX(rs.last_execution_time) AS last_execution_time
        FROM sys.query_store_query qs
        JOIN sys.query_store_query_text qt ON qs.query_text_id = qt.query_text_id
        JOIN sys.query_store_plan qp ON qs.query_id = qp.query_id
        JOIN sys.query_store_runtime_stats rs ON qp.plan_id = rs.plan_id
        WHERE rs.last_execution_time > DATEADD(HOUR, -${timespanHours}, GETUTCDATE())
        GROUP BY qs.query_id, SUBSTRING(qt.query_sql_text, 1, 500)
        ORDER BY MAX(rs.max_cpu_time) DESC`;

        const request = new Request(sql, (reqErr) => { connection.close(); if (reqErr) reject(reqErr); else resolve(rows); });
        request.on("row", (columns: Array<{ metadata: { colName: string }; value: unknown }>) => {
          const row: Record<string, unknown> = {};
          for (const col of columns) row[col.metadata.colName] = col.value;
          rows.push({
            queryId: row["query_id"] as number, querySqlText: (row["query_sql_text"] as string) ?? "",
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
    });
    return { topQueries };
  } catch (err) {
    return { topQueries: [], error: { code: "QUERY_STORE_ERROR", message: `querySqlQueryStore failed: ${err instanceof Error ? err.message : String(err)}`, roleRecommendation: "Ensure Azure AD admin is set on the SQL server and the identity has VIEW DATABASE STATE permission." } };
  }
}

// ─── RBAC Queries ────────────────────────────────────────────────────

export interface RoleAssignmentInfo {
  id: string;
  principalId: string;
  principalType: string;
  roleDefinitionId: string;
  roleDefinitionName: string;
  scope: string;
  createdOn: string;
}

export async function queryRoleAssignments(
  subscriptionId: string,
  scope?: string
): Promise<{ assignments: RoleAssignmentInfo[]; totalCount: number; error?: AzureError }> {
  try {
    const scopeFilter = scope ? `| where properties.scope =~ '${scope}'` : "";
    const query = `authorizationresources | where type == 'microsoft.authorization/roleassignments' ${scopeFilter} | project principalId = properties.principalId, principalType = properties.principalType, roleDefinitionId = properties.roleDefinitionId, scope = properties.scope, createdOn = properties.createdOn | take 1000`;
    const result = await queryResourceGraph([subscriptionId], query);
    if (result.error) return { assignments: [], totalCount: 0, error: result.error };
    const assignments: RoleAssignmentInfo[] = result.resources.map((r) => ({
      id: String(r["id"] ?? ""),
      principalId: String(r["principalId"] ?? ""),
      principalType: String(r["principalType"] ?? ""),
      roleDefinitionId: String(r["roleDefinitionId"] ?? ""),
      roleDefinitionName: String(r["roleDefinitionId"] ?? "").split("/").pop() ?? "",
      scope: String(r["scope"] ?? ""),
      createdOn: String(r["createdOn"] ?? ""),
    }));
    return { assignments, totalCount: result.totalRecords };
  } catch (err) {
    return { assignments: [], totalCount: 0, error: classifyError(err, "rbac") };
  }
}

export async function queryCustomRoleDefinitions(
  subscriptionId: string
): Promise<{ roles: Array<{ id: string; name: string; roleName: string; description: string; permissions: number }>; totalCount: number; error?: AzureError }> {
  try {
    const query = `authorizationresources | where type == 'microsoft.authorization/roledefinitions' | where properties.type == 'CustomRole' | project id, name, roleName = properties.roleName, description = properties.description, permissions = array_length(properties.permissions) | take 500`;
    const result = await queryResourceGraph([subscriptionId], query);
    if (result.error) return { roles: [], totalCount: 0, error: result.error };
    const roles = result.resources.map((r) => ({
      id: String(r["id"] ?? ""), name: String(r["name"] ?? ""), roleName: String(r["roleName"] ?? ""),
      description: String(r["description"] ?? ""), permissions: Number(r["permissions"] ?? 0),
    }));
    return { roles, totalCount: result.totalRecords };
  } catch (err) {
    return { roles: [], totalCount: 0, error: classifyError(err, "rbac") };
  }
}

const RBAC_ERROR_CODES = [
  "AuthorizationFailed", "LinkedAuthorizationFailed",
  "RoleAssignmentLimitExceeded", "RoleDefinitionLimitExceeded",
  "PrincipalNotFound", "RoleAssignmentUpdateNotPermitted",
];

export function getRecommendedRoleForOperation(operation: string): string {
  const op = operation.toLowerCase();
  const recommendations: Record<string, string> = {
    "write": "Contributor", "delete": "Contributor", "action": "Contributor",
    "roleassignments": "User Access Administrator", "locks": "Owner",
    "policyassignments": "Resource Policy Contributor",
  };
  for (const [key, role] of Object.entries(recommendations)) {
    if (op.includes(key)) return role;
  }
  return "Check your RBAC role assignments on the target scope.";
}

export async function queryRbacActivityFailures(
  subscriptionId: string,
  timespanHours: number = 24
): Promise<{ failures: Array<{ time: string; operation: string; caller: string; errorCode: string; recommendation: string }>; error?: AzureError }> {
  try {
    const result = await getActivityLogs(subscriptionId, timespanHours);
    if (result.error) return { failures: [], error: result.error };
    const failures: Array<{ time: string; operation: string; caller: string; errorCode: string; recommendation: string }> = [];
    for (const event of result.events) {
      if (event.status?.value !== "Failed") continue;
      const subStatus = event.subStatus?.value ?? "";
      const statusMessage = (event.properties as Record<string, string> | undefined)?.statusMessage ?? "";
      const op = event.operationName?.value ?? "";
      const matchedCode = RBAC_ERROR_CODES.find((code) => subStatus.includes(code) || statusMessage.includes(code));
      if (!matchedCode) continue;
      let recommendation: string;
      if (matchedCode === "AuthorizationFailed" || matchedCode === "LinkedAuthorizationFailed") {
        recommendation = `Assign ${getRecommendedRoleForOperation(op)} at the resource group or resource scope.`;
      } else if (matchedCode === "RoleAssignmentLimitExceeded") {
        recommendation = "Approaching role assignment limit. Consolidate using group-based assignments.";
      } else {
        recommendation = `Review RBAC configuration. Error: ${matchedCode}`;
      }
      failures.push({ time: event.eventTimestamp?.toISOString() ?? "", operation: op, caller: event.caller ?? "", errorCode: matchedCode, recommendation });
    }
    return { failures };
  } catch (err) {
    return { failures: [], error: classifyError(err, "rbac") };
  }
}

// ─── Kubectl ────────────────────────────────────────────────────────

export interface KubectlResult {
  data: unknown;
  error?: AzureError;
}

/**
 * Get AKS credentials and run a kubectl command, returning parsed JSON.
 * Automatically fetches kubeconfig for the cluster if needed.
 */
export async function runKubectl(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  command: string
): Promise<KubectlResult> {
  try {
    // Get credentials (merges into kubeconfig)
    execSync(
      `az aks get-credentials --subscription ${subscriptionId} --resource-group ${resourceGroup} --name ${clusterName} --overwrite-existing`,
      { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }
    );

    // Run kubectl command with JSON output
    const output = execSync(`kubectl ${command} -o json`, {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { data: JSON.parse(output) };
  } catch (err) {
    return {
      data: null,
      error: {
        code: "KUBECTL_ERROR",
        message: `kubectl failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Get pod details for AKS investigation — env vars, resource limits,
 * restart reasons, container status.
 */
export async function getAksPodDiagnostics(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string
): Promise<{
  pods: Array<{
    name: string;
    namespace: string;
    status: string;
    restarts: number;
    exitCode: number | null;
    reason: string | null;
    memoryLimit: string | null;
    memoryRequest: string | null;
    cpuLimit: string | null;
    cpuRequest: string | null;
    envDatabaseRefs: string[];
  }>;
  error?: AzureError;
}> {
  try {
    const podsResult = await runKubectl(
      subscriptionId, resourceGroup, clusterName,
      "get pods --all-namespaces"
    );
    if (podsResult.error) return { pods: [], error: podsResult.error };

    const podList = podsResult.data as {
      items: Array<{
        metadata: { name: string; namespace: string };
        status: {
          phase: string;
          containerStatuses?: Array<{
            name: string;
            restartCount: number;
            lastState?: { terminated?: { exitCode: number; reason: string } };
          }>;
        };
        spec: {
          containers: Array<{
            name: string;
            resources?: { limits?: { memory?: string; cpu?: string }; requests?: { memory?: string; cpu?: string } };
            env?: Array<{ name: string; value?: string }>;
          }>;
        };
      }>;
    };

    // Filter to non-system pods
    const userPods = (podList.items ?? []).filter(
      (p) => !p.metadata.namespace.startsWith("kube-") && p.metadata.namespace !== "gatekeeper-system"
    );

    const pods = userPods.map((pod) => {
      const container = pod.spec.containers[0];
      const containerStatus = pod.status.containerStatuses?.[0];

      // Find database-related env vars
      const envDatabaseRefs: string[] = [];
      for (const env of container?.env ?? []) {
        const val = env.value ?? "";
        if (/PG_|POSTGRES|DATABASE|SQL|REDIS|COSMOS|MONGO/i.test(env.name) && val) {
          envDatabaseRefs.push(`${env.name}=${val}`);
        } else if (/\.database\.windows\.net|\.postgres\.database\.azure\.com|\.redis\.cache\.windows\.net|\.documents\.azure\.com|\.mongo\.cosmos\.azure\.com/i.test(val)) {
          envDatabaseRefs.push(`${env.name}=${val}`);
        }
      }

      return {
        name: pod.metadata.name,
        namespace: pod.metadata.namespace,
        status: pod.status.phase,
        restarts: containerStatus?.restartCount ?? 0,
        exitCode: containerStatus?.lastState?.terminated?.exitCode ?? null,
        reason: containerStatus?.lastState?.terminated?.reason ?? null,
        memoryLimit: container?.resources?.limits?.memory ?? null,
        memoryRequest: container?.resources?.requests?.memory ?? null,
        cpuLimit: container?.resources?.limits?.cpu ?? null,
        cpuRequest: container?.resources?.requests?.cpu ?? null,
        envDatabaseRefs,
      };
    });

    return { pods };
  } catch (err) {
    return {
      pods: [],
      error: { code: "AKS_POD_DIAG_ERROR", message: `Failed: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}

// ─── Concurrency Limiter ────────────────────────────────────────────

export async function batchExecute<T>(
  tasks: (() => Promise<T>)[],
  batchSize: number = 5
): Promise<T[]> {
  const results: T[] = [];

  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((fn) => fn()));
    results.push(...batchResults);
  }

  return results;
}

// ─── VM Boot Diagnostics ────────────────────────────────────────────

export interface VmInstanceInfo {
  powerState: string;
  provisioningState: string;
  vmAgentStatus: string;
  vmAgentVersion: string;
}

export interface BootErrorFinding {
  pattern: string;
  detail: string;
  suggestedAction: string;
}

export interface VmBootDiagnosticsResult {
  instanceInfo: VmInstanceInfo;
  serialConsoleLog: string | null;
  bootErrors: BootErrorFinding[];
  error?: AzureError;
}

/**
 * Retrieve VM instance view (power state, agent status) and serial console
 * boot log. The serial console log contains Windows boot manager output,
 * including BCD errors, missing file references, and blue-screen codes.
 */
export async function getVmBootDiagnostics(
  subscriptionId: string,
  resourceGroup: string,
  vmName: string
): Promise<VmBootDiagnosticsResult> {
  try {
    const client = await createComputeClient(subscriptionId);

    // Get instance view for power state and VM agent status
    const instanceView = await withRetry(() =>
      client.virtualMachines.instanceView(resourceGroup, vmName)
    );

    const statuses = instanceView.statuses ?? [];
    const powerStatus = statuses.find((s) => s.code?.startsWith("PowerState/"));
    const provStatus = statuses.find((s) => s.code?.startsWith("ProvisioningState/"));

    const agentStatuses = instanceView.vmAgent?.statuses ?? [];
    const agentReady = agentStatuses.find((s) => s.code?.includes("ProvisioningState/"));

    const instanceInfo: VmInstanceInfo = {
      powerState: powerStatus?.displayStatus ?? "Unknown",
      provisioningState: provStatus?.displayStatus ?? "Unknown",
      vmAgentStatus: agentReady?.displayStatus ?? "Not reporting",
      vmAgentVersion: instanceView.vmAgent?.vmAgentVersion ?? "Unknown",
    };

    // Retrieve boot diagnostics serial console log
    let serialConsoleLog: string | null = null;
    try {
      const bootDiagData = await withRetry(() =>
        client.virtualMachines.retrieveBootDiagnosticsData(resourceGroup, vmName)
      );

      if (bootDiagData.serialConsoleLogBlobUri) {
        const response = await fetch(bootDiagData.serialConsoleLogBlobUri);
        if (response.ok) {
          const fullLog = await response.text();
          // Return the last 4KB to stay within reasonable response size
          const MAX_LOG_SIZE = 4096;
          serialConsoleLog = fullLog.length > MAX_LOG_SIZE
            ? fullLog.slice(-MAX_LOG_SIZE)
            : fullLog;
        }
      }
    } catch {
      // Boot diagnostics may not be enabled — not a fatal error
    }

    // Scan serial console log for known boot error patterns
    const bootErrors = detectBootErrors(serialConsoleLog, instanceInfo);

    return { instanceInfo, serialConsoleLog, bootErrors };
  } catch (err) {
    return {
      instanceInfo: {
        powerState: "Unknown",
        provisioningState: "Unknown",
        vmAgentStatus: "Unknown",
        vmAgentVersion: "Unknown",
      },
      serialConsoleLog: null,
      bootErrors: [],
      error: classifyError(err, "vmBootDiagnostics"),
    };
  }
}

function detectBootErrors(log: string | null, instanceInfo: VmInstanceInfo): BootErrorFinding[] {
  const findings: BootErrorFinding[] = [];
  const text = (log ?? "").toLowerCase();

  // BCD corruption / boot config errors
  if (text.includes("0xc000000f") || text.includes("boot configuration data") || /winload\.(exe|efi).*missing|missing.*winload/i.test(log ?? "")) {
    findings.push({
      pattern: "BCD corruption (0xc000000f)",
      detail: "Boot Configuration Data is corrupted or pointing to a non-existent boot loader path.",
      suggestedAction: "Create a repair VM, attach this VM's OS disk, and use bcdedit to fix the boot loader path (winload.efi).",
    });
  }

  // Missing or corrupt winload
  if (/\\[^\s]*winload/i.test(log ?? "") && (text.includes("missing") || text.includes("cannot be found") || text.includes("not found"))) {
    const pathMatch = (log ?? "").match(/File:\s*([^\r\n]+)/i);
    if (pathMatch && !findings.some((f) => f.pattern.includes("BCD"))) {
      findings.push({
        pattern: "Missing boot loader",
        detail: `Boot loader path "${pathMatch[1].trim()}" does not exist or is corrupted.`,
        suggestedAction: "Verify the file exists on the OS disk. If missing, repair BCD to point to the correct winload.efi path.",
      });
    }
  }

  // Blue screen / bug check
  if (text.includes("bug check") || text.includes("stop code") || text.includes("blue screen") || /0x000000[0-9a-f]{2}/i.test(log ?? "")) {
    const codeMatch = (log ?? "").match(/(0x[0-9A-Fa-f]{8,})/);
    findings.push({
      pattern: "Blue screen (BSOD)",
      detail: `Blue screen error detected${codeMatch ? `: stop code ${codeMatch[1]}` : ""}.`,
      suggestedAction: "Check for recent driver updates or OS patches. Boot into safe mode or use a repair VM to investigate.",
    });
  }

  // Inaccessible boot device
  if (text.includes("inaccessible_boot_device") || text.includes("inaccessible boot device")) {
    findings.push({
      pattern: "Inaccessible boot device",
      detail: "The OS cannot access the boot disk. This may be caused by disk encryption, driver issues, or disk corruption.",
      suggestedAction: "Check if disk encryption (BitLocker/ADE) is enabled. Verify disk is attached correctly. Try attaching to a repair VM.",
    });
  }

  // Kernel panic (Linux)
  if (text.includes("kernel panic") || text.includes("not syncing")) {
    findings.push({
      pattern: "Kernel panic",
      detail: "Linux kernel panic — the OS encountered an unrecoverable error during boot.",
      suggestedAction: "Check for recent kernel updates. Boot with a previous kernel version or use a repair VM to inspect /var/log/.",
    });
  }

  // GRUB errors (Linux)
  if (text.includes("grub") && (text.includes("error") || text.includes("not found") || text.includes("unknown filesystem"))) {
    findings.push({
      pattern: "GRUB boot loader error",
      detail: "GRUB cannot find the boot partition or filesystem. Boot configuration may be corrupted.",
      suggestedAction: "Attach OS disk to a repair VM and rebuild GRUB configuration (grub-install, update-grub).",
    });
  }

  // fstab errors (Linux)
  if (text.includes("mount") && (text.includes("failed") || text.includes("does not exist")) && text.includes("fstab")) {
    findings.push({
      pattern: "fstab mount failure",
      detail: "A filesystem entry in /etc/fstab failed to mount, preventing boot completion.",
      suggestedAction: "Attach OS disk to a repair VM and fix /etc/fstab — comment out or correct the failing mount entry.",
    });
  }

  // VM Agent not ready combined with low CPU — likely OS not booting
  if (instanceInfo.vmAgentStatus === "Not reporting" && instanceInfo.powerState.includes("running")) {
    findings.push({
      pattern: "VM running but guest OS unresponsive",
      detail: "VM is powered on but the VM agent is not reporting. The guest OS may not have booted successfully.",
      suggestedAction: "Check the serial console log for boot errors. If no log is available, enable boot diagnostics and restart the VM.",
    });
  }

  return findings;
}
