import { z } from "zod";
import { queryResourceGraph, batchResourceHealth, getActivityLogs, } from "../utils/azure-client.js";
export function registerHealthcheck(server) {
    server.tool("azdoctor_healthcheck", "Scan a subscription or resource group for health issues, anomalies, and risks. Returns a risk-scored summary of findings across all resources.", {
        subscription: z.string().describe("Azure subscription ID"),
        resourceGroup: z
            .string()
            .optional()
            .describe("Scope to a specific resource group"),
        severity: z
            .enum(["critical", "warning", "info"])
            .default("warning")
            .describe("Minimum severity threshold for reported findings"),
    }, async ({ subscription, resourceGroup, severity }) => {
        const findings = [];
        const errors = [];
        // 1. Query Resource Graph for all resources in scope
        const rgQuery = resourceGroup
            ? `Resources | where resourceGroup =~ '${resourceGroup}' | project id, name, type, location, resourceGroup`
            : `Resources | project id, name, type, location, resourceGroup`;
        const resourceList = await queryResourceGraph([subscription], rgQuery);
        if (resourceList.error)
            errors.push(resourceList.error);
        const scannedResources = resourceList.totalRecords;
        // 2. Batch-check Resource Health
        const healthResult = await batchResourceHealth(subscription, resourceGroup);
        if (healthResult.error) {
            errors.push(healthResult.error);
        }
        else {
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
                            detailedStatus: status.properties?.detailedStatus,
                        },
                        recommendation: status.properties?.recommendedActions?.[0]?.action ??
                            "Check Azure Service Health for platform events, then review recent changes.",
                    });
                }
                else if (state === "Degraded") {
                    findings.push({
                        severity: "critical",
                        resource: resourceName,
                        resourceType,
                        issue: `Resource is degraded: ${status.properties?.summary ?? "No details"}`,
                        evidence: {
                            availabilityState: state,
                            reasonType: status.properties?.reasonType,
                        },
                        recommendation: "Investigate recent deployments or configuration changes. Check dependent resources.",
                    });
                }
            }
        }
        // 3. Pull Activity Log for last 24h — count changes per resource, flag unusual velocity
        const activityResult = await getActivityLogs(subscription, 24, undefined, resourceGroup);
        if (activityResult.error) {
            errors.push(activityResult.error);
        }
        else {
            // Count changes per resource
            const changesByResource = new Map();
            let failedDeployments = 0;
            for (const event of activityResult.events) {
                const resId = event.resourceId ?? "unknown";
                changesByResource.set(resId, (changesByResource.get(resId) ?? 0) + 1);
                // Flag failed deployments
                if (event.status?.value === "Failed" &&
                    event.operationName?.value?.includes("deployments")) {
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
                            caller: event.caller,
                        },
                        recommendation: "Review deployment logs for error details. Check ARM template or deployment parameters.",
                    });
                }
            }
            // Flag high change velocity (> 20 changes on a single resource in 24h)
            for (const [resId, count] of changesByResource) {
                if (count > 20) {
                    const resourceName = resId.split("/").pop() ?? "unknown";
                    findings.push({
                        severity: "warning",
                        resource: resourceName,
                        resourceType: "unknown",
                        issue: `High change velocity: ${count} changes in last 24h`,
                        evidence: { changeCount: count, resourceId: resId },
                        recommendation: "Review whether repeated changes indicate a flapping deployment or configuration drift.",
                    });
                }
            }
        }
        // 4. Filter by severity threshold
        const severityRank = {
            critical: 3,
            warning: 2,
            info: 1,
        };
        const minRank = severityRank[severity] ?? 2;
        const filtered = findings.filter((f) => (severityRank[f.severity] ?? 0) >= minRank);
        // 5. Calculate risk score (0-100)
        const criticalCount = filtered.filter((f) => f.severity === "critical").length;
        const warningCount = filtered.filter((f) => f.severity === "warning").length;
        const infoCount = filtered.filter((f) => f.severity === "info").length;
        const riskScore = Math.min(100, criticalCount * 30 + warningCount * 10 + infoCount * 2);
        const healthyCount = Math.max(0, scannedResources - criticalCount - warningCount);
        const response = {
            riskScore,
            summary: `${criticalCount} critical, ${warningCount} warning, ${healthyCount} healthy`,
            findings: filtered,
            scannedResources,
            timestamp: new Date().toISOString(),
            errors: errors.length > 0 ? errors : undefined,
        };
        return {
            content: [
                { type: "text", text: JSON.stringify(response, null, 2) },
            ],
        };
    });
}
//# sourceMappingURL=healthcheck.js.map