import { z } from "zod";
import { resolveSubscription, queryResourceGraph, getMetrics, } from "../utils/azure-client.js";
import { getMetricConfig } from "../utils/metric-config.js";
function calculateMean(values) {
    if (values.length === 0)
        return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}
function calculateStdDev(values, mean) {
    if (values.length < 2)
        return 0;
    const sumSquaredDiffs = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
    return Math.sqrt(sumSquaredDiffs / (values.length - 1));
}
export function registerBaseline(server) {
    server.tool("azdoctor_baseline", "Compare current resource metrics against their 7-day baseline. Flags deviations beyond 2 standard deviations to answer 'is this normal?'", {
        resource: z
            .string()
            .describe("Resource name or full Azure resource ID"),
        subscription: z.string().optional(),
        resourceGroup: z.string().optional(),
        baselineDays: z
            .number()
            .default(7)
            .describe("Days of history to use as baseline"),
    }, async ({ resource, subscription: subParam, resourceGroup, baselineDays }) => {
        const subscription = await resolveSubscription(subParam);
        // 1. Resolve the resource
        let resourceId;
        let resourceType;
        if (resource.startsWith("/")) {
            // Full resource ID provided
            resourceId = resource;
            // Extract resource type from the ID
            const typeMatch = resource.match(/\/providers\/([^/]+\/[^/]+)/i);
            resourceType = typeMatch ? typeMatch[1] : "unknown";
        }
        else {
            // Search by name via Resource Graph
            const query = resourceGroup
                ? `Resources | where name =~ '${resource}' and resourceGroup =~ '${resourceGroup}' | project id, name, type | take 1`
                : `Resources | where name =~ '${resource}' | project id, name, type | take 1`;
            const rgResult = await queryResourceGraph([subscription], query);
            if (rgResult.error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                error: `Failed to resolve resource: ${rgResult.error.message}`,
                            }, null, 2),
                        },
                    ],
                };
            }
            if (rgResult.resources.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                error: `Resource '${resource}' not found in subscription ${subscription}${resourceGroup ? ` / resource group ${resourceGroup}` : ""}.`,
                            }, null, 2),
                        },
                    ],
                };
            }
            const resolved = rgResult.resources[0];
            resourceId = resolved.id;
            resourceType = resolved.type;
        }
        // 2. Get metric config for this resource type
        const metricConfig = getMetricConfig(resourceType);
        if (!metricConfig) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            error: `No metric configuration found for resource type '${resourceType}'. Baseline comparison is not supported for this resource type.`,
                        }, null, 2),
                    },
                ],
            };
        }
        // 3. Pull metrics for the full baseline period
        const timespanHours = baselineDays * 24;
        const metricsResult = await getMetrics(resourceId, metricConfig.names, timespanHours, "PT1H");
        if (metricsResult.error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            error: `Failed to retrieve metrics: ${metricsResult.error.message}`,
                        }, null, 2),
                    },
                ],
            };
        }
        if (!metricsResult.data) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ error: "No metric data returned." }, null, 2),
                    },
                ],
            };
        }
        // 4. Analyze each metric
        const baselineMetrics = [];
        for (const metric of metricsResult.data.metrics) {
            const metricName = metric.name;
            const timeSeries = metric.timeseries;
            if (!timeSeries || timeSeries.length === 0)
                continue;
            // Collect all average data points
            const allValues = [];
            let lastValue = null;
            for (const ts of timeSeries) {
                const dataPoints = ts.data ?? [];
                for (const dp of dataPoints) {
                    const val = dp.average ?? dp.maximum;
                    if (val !== undefined && val !== null) {
                        allValues.push(val);
                        lastValue = val;
                    }
                }
            }
            if (allValues.length < 2 || lastValue === null)
                continue;
            // Calculate baseline statistics over the full period
            const mean = calculateMean(allValues);
            const stddev = calculateStdDev(allValues, mean);
            // The most recent data point as the "current" value
            const current = lastValue;
            // Calculate z-score
            const zScore = stddev > 0 ? (current - mean) / stddev : 0;
            const absZ = Math.abs(zScore);
            // Classify
            let status;
            if (absZ >= 2) {
                status = "anomalous";
            }
            else if (absZ >= 1) {
                status = "elevated";
            }
            else {
                status = "normal";
            }
            // Direction
            let direction;
            if (zScore > 0.1) {
                direction = "above";
            }
            else if (zScore < -0.1) {
                direction = "below";
            }
            else {
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
                description,
            });
        }
        // Determine overall status
        const anomalousCount = baselineMetrics.filter((m) => m.status === "anomalous").length;
        const elevatedCount = baselineMetrics.filter((m) => m.status === "elevated").length;
        let overallStatus;
        if (anomalousCount >= 2) {
            overallStatus = "significant_anomalies";
        }
        else if (anomalousCount >= 1 || elevatedCount >= 2) {
            overallStatus = "some_anomalies";
        }
        else {
            overallStatus = "normal";
        }
        const response = {
            resource: resourceId,
            resourceType,
            baselineDays,
            overallStatus,
            metrics: baselineMetrics,
            timestamp: new Date().toISOString(),
        };
        return {
            content: [
                { type: "text", text: JSON.stringify(response, null, 2) },
            ],
        };
    });
}
//# sourceMappingURL=baseline.js.map