import { z } from "zod";
import { resolveSubscription, queryResourceGraph, batchResourceHealth, getActivityLogs, } from "../utils/azure-client.js";
export function registerHealthcheck(server) {
    server.tool("azdoctor_healthcheck", "Scan a subscription or resource group for health issues, anomalies, and risks. Returns a risk-scored summary of findings across all resources.", {
        subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
        resourceGroup: z
            .string()
            .optional()
            .describe("Scope to a specific resource group"),
        severity: z
            .enum(["critical", "warning", "info"])
            .default("warning")
            .describe("Minimum severity threshold for reported findings"),
    }, async ({ subscription: subParam, resourceGroup, severity }) => {
        const subscription = await resolveSubscription(subParam);
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
        // 2. Run health checks, activity log checks, and Resource Graph misconfiguration checks in parallel
        const [healthResult, activityResult, ...rgCheckResults] = await Promise.all([
            // Health check
            batchResourceHealth(subscription, resourceGroup),
            // Activity logs
            getActivityLogs(subscription, 24, undefined, resourceGroup),
            // Resource Graph checks for common misconfigurations
            queryResourceGraph([subscription], resourceGroup
                ? `Resources | where resourceGroup =~ '${resourceGroup}' and type =~ 'Microsoft.Compute/disks' and properties.diskState == 'Unattached' | project id, name, type, location, resourceGroup`
                : `Resources | where type =~ 'Microsoft.Compute/disks' and properties.diskState == 'Unattached' | project id, name, type, location, resourceGroup`),
            queryResourceGraph([subscription], resourceGroup
                ? `Resources | where resourceGroup =~ '${resourceGroup}' and type =~ 'Microsoft.Network/publicIPAddresses' and properties.ipConfiguration == '' | project id, name, type, location, resourceGroup`
                : `Resources | where type =~ 'Microsoft.Network/publicIPAddresses' and properties.ipConfiguration == '' | project id, name, type, location, resourceGroup`),
            queryResourceGraph([subscription], resourceGroup
                ? `Resources | where resourceGroup =~ '${resourceGroup}' and (type startswith 'Microsoft.ClassicCompute' or type startswith 'Microsoft.ClassicNetwork' or type startswith 'Microsoft.ClassicStorage') | project id, name, type, location, resourceGroup`
                : `Resources | where type startswith 'Microsoft.ClassicCompute' or type startswith 'Microsoft.ClassicNetwork' or type startswith 'Microsoft.ClassicStorage' | project id, name, type, location, resourceGroup`),
            queryResourceGraph([subscription], resourceGroup
                ? `Resources | where resourceGroup =~ '${resourceGroup}' and (type =~ 'Microsoft.Sql/servers' or type =~ 'Microsoft.KeyVault/vaults' or type =~ 'Microsoft.DocumentDB/databaseAccounts') | project id, name, type, resourceGroup`
                : `Resources | where (type =~ 'Microsoft.Sql/servers' or type =~ 'Microsoft.KeyVault/vaults' or type =~ 'Microsoft.DocumentDB/databaseAccounts') | project id, name, type, resourceGroup`),
        ]);
        const [unattachedDisksResult, unassociatedIPsResult, classicResourcesResult, criticalResourcesResult] = rgCheckResults;
        // Process Resource Health findings
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
        // Process Activity Log findings
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
        // Process Resource Graph misconfiguration findings
        // Unattached disks
        let unattachedDiskCount = 0;
        if (unattachedDisksResult.error) {
            errors.push(unattachedDisksResult.error);
        }
        else {
            for (const disk of unattachedDisksResult.resources) {
                unattachedDiskCount++;
                findings.push({
                    severity: "warning",
                    resource: String(disk.name ?? "unknown"),
                    resourceType: "Microsoft.Compute/disks",
                    issue: `Unattached managed disk detected — incurring cost without being used.`,
                    evidence: {
                        id: disk.id,
                        location: disk.location,
                        resourceGroup: disk.resourceGroup,
                    },
                    recommendation: "Delete the disk if no longer needed, or reattach it to a VM to avoid wasted cost.",
                });
            }
        }
        // Unassociated Public IPs
        let unassociatedIPCount = 0;
        if (unassociatedIPsResult.error) {
            errors.push(unassociatedIPsResult.error);
        }
        else {
            for (const ip of unassociatedIPsResult.resources) {
                unassociatedIPCount++;
                findings.push({
                    severity: "info",
                    resource: String(ip.name ?? "unknown"),
                    resourceType: "Microsoft.Network/publicIPAddresses",
                    issue: `Public IP address is not associated with any resource.`,
                    evidence: {
                        id: ip.id,
                        location: ip.location,
                        resourceGroup: ip.resourceGroup,
                    },
                    recommendation: "Review whether this public IP is still needed. Unassociated public IPs may pose a security risk and incur cost.",
                });
            }
        }
        // Classic resources
        let classicResourceCount = 0;
        if (classicResourcesResult.error) {
            errors.push(classicResourcesResult.error);
        }
        else {
            for (const res of classicResourcesResult.resources) {
                classicResourceCount++;
                findings.push({
                    severity: "warning",
                    resource: String(res.name ?? "unknown"),
                    resourceType: String(res.type ?? "Microsoft.Classic*"),
                    issue: `Classic (ASM) resource detected — this deployment model is deprecated.`,
                    evidence: {
                        id: res.id,
                        type: res.type,
                        location: res.location,
                        resourceGroup: res.resourceGroup,
                    },
                    recommendation: "Migrate to Azure Resource Manager (ARM). Classic resources will be retired. See https://aka.ms/classicresourcemigration.",
                });
            }
        }
        // Critical resources without locks
        if (criticalResourcesResult.error) {
            errors.push(criticalResourcesResult.error);
        }
        else {
            for (const res of criticalResourcesResult.resources) {
                findings.push({
                    severity: "info",
                    resource: String(res.name ?? "unknown"),
                    resourceType: String(res.type ?? "unknown"),
                    issue: `Critical resource type detected — review whether resource locks are configured.`,
                    evidence: {
                        id: res.id,
                        type: res.type,
                        resourceGroup: res.resourceGroup,
                    },
                    recommendation: "Consider adding a CanNotDelete or ReadOnly lock to protect this critical resource from accidental deletion or modification.",
                });
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
        const riskScore = Math.min(100, criticalCount * 30 +
            warningCount * 10 +
            infoCount * 2 +
            unattachedDiskCount * 3 +
            classicResourceCount * 5 +
            unassociatedIPCount * 2);
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