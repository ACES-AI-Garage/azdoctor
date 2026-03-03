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
export declare function queryResourceGraph(subscriptions: string[], query: string): Promise<ResourceGraphResult>;
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
export declare function getActivityLogs(subscriptionId: string, hoursBack?: number, resourceUri?: string, resourceGroup?: string): Promise<ActivityLogResult>;
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
//# sourceMappingURL=azure-client.d.ts.map