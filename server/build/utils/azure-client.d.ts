import type { TokenCredential } from "@azure/identity";
import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import { MicrosoftResourceHealth } from "@azure/arm-resourcehealth";
import type { AvailabilityStatus } from "@azure/arm-resourcehealth";
import { MonitorClient } from "@azure/arm-monitor";
import type { EventData } from "@azure/arm-monitor";
import { LogsQueryClient, MetricsQueryClient } from "@azure/monitor-query";
import type { MetricsQueryResult } from "@azure/monitor-query";
import { MicrosoftSupport } from "@azure/arm-support";
export declare function getCredential(): TokenCredential;
/**
 * Resolve the Azure subscription ID from multiple sources:
 * 1. Explicit parameter (if provided)
 * 2. AZURE_SUBSCRIPTION_ID environment variable
 * 3. Default subscription from `az account show`
 */
export declare function resolveSubscription(explicit?: string): Promise<string>;
export interface AzureError {
    code: string;
    message: string;
    roleRecommendation?: string;
}
export declare function createResourceGraphClient(): ResourceGraphClient;
export declare function createResourceHealthClient(subscriptionId: string): MicrosoftResourceHealth;
export declare function createMonitorClient(subscriptionId: string): MonitorClient;
export declare function createLogsQueryClient(): LogsQueryClient;
export declare function createMetricsQueryClient(): MetricsQueryClient;
export declare function createSupportClient(subscriptionId: string): MicrosoftSupport;
export interface ResourceGraphResult {
    resources: Record<string, unknown>[];
    totalRecords: number;
    error?: AzureError;
}
export declare function clearResourceGraphCache(): void;
export declare function queryResourceGraph(subscriptions: string[], query: string, skipCache?: boolean): Promise<ResourceGraphResult>;
export interface DiagnosticSettingInfo {
    name: string;
    workspaceId: string;
    workspaceCustomerId?: string;
    logs: string[];
    metrics: boolean;
}
export declare function getResourceDiagnosticSettings(subscriptionId: string, resourceUri: string): Promise<{
    settings: DiagnosticSettingInfo[];
    error?: AzureError;
}>;
export interface HealthResult {
    statuses: AvailabilityStatus[];
    error?: AzureError;
}
export declare function getResourceHealth(subscriptionId: string, resourceUri: string): Promise<HealthResult>;
export declare function batchResourceHealth(subscriptionId: string, resourceGroup?: string): Promise<HealthResult>;
export interface ActivityLogResult {
    events: EventData[];
    error?: AzureError;
}
export declare function getActivityLogs(subscriptionId: string, hoursBack?: number, resourceUri?: string, resourceGroup?: string, maxEvents?: number): Promise<ActivityLogResult>;
export interface MetricsResult {
    data: MetricsQueryResult | null;
    error?: AzureError;
}
export declare function getMetrics(resourceUri: string, metricNames: string[], timespanHours?: number, granularity?: string): Promise<MetricsResult>;
export interface LogAnalyticsResult {
    tables: Array<{
        name: string;
        columns: string[];
        rows: unknown[][];
    }>;
    error?: AzureError;
}
export declare function queryLogAnalytics(workspaceId: string, query: string, timespanHours?: number): Promise<LogAnalyticsResult>;
export interface WorkspaceInfo {
    workspaceId: string;
    workspaceName: string;
    resourceId: string;
}
export declare function discoverWorkspaces(subscriptionId: string, resourceGroup?: string): Promise<{
    workspaces: WorkspaceInfo[];
    error?: AzureError;
}>;
export declare function batchExecute<T>(tasks: (() => Promise<T>)[], batchSize?: number): Promise<T[]>;
//# sourceMappingURL=azure-client.d.ts.map