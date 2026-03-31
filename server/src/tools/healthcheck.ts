import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
  batchResourceHealth,
  getActivityLogs,
  queryRoleAssignments,
  queryRbacActivityFailures,
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";

interface Finding {
  severity: "critical" | "warning" | "info";
  resource: string;
  resourceType: string;
  issue: string;
  category?: string;
  evidence: Record<string, unknown>;
  recommendation: string;
}


export function registerHealthcheck(server: McpServer): void {
  server.tool(
    "azdoctor_healthcheck",
    "Scan a subscription or resource group for health issues, Azure Advisor recommendations, and operational risks. Returns a risk-scored summary powered by Resource Health, Azure Advisor, and Activity Logs.",
    {
      subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z
        .string()
        .optional()
        .describe("Scope to a specific resource group"),
      severity: z
        .enum(["critical", "warning", "info"])
        .default("warning")
        .describe("Minimum severity threshold for reported findings"),
    },
    async ({ subscription: subParam, resourceGroup, severity }) => {
      const subscription = await resolveSubscription(subParam);
      const findings: Finding[] = [];
      const errors: AzureError[] = [];

      // 1. Count resources in scope
      const rgCountQuery = resourceGroup
        ? `Resources | where resourceGroup =~ '${resourceGroup}' | summarize count()`
        : `Resources | summarize count()`;
      const resourceCountResult = await queryResourceGraph([subscription], rgCountQuery);
      if (resourceCountResult.error) errors.push(resourceCountResult.error);
      const scannedResources = resourceCountResult.resources.length > 0
        ? (resourceCountResult.resources[0]["count_"] as number) ?? 0
        : 0;

      // 2. Run Resource Health, Activity Logs, and Advisor in parallel
      // Only fetch Cost recommendations — HA/Security/Perf/OpEx are noise in a health check.
      const advisorQuery = resourceGroup
        ? [
            "advisorresources",
            "| where type == 'microsoft.advisor/recommendations'",
            "| where properties.category =~ 'Cost'",
            `| where resourceGroup =~ '${resourceGroup}'`,
            "| project id, name, resourceGroup,",
            "    category = properties.category,",
            "    problem = properties.shortDescription.problem,",
            "    solution = properties.shortDescription.solution,",
            "    affectedResource = properties.impactedValue,",
            "    affectedResourceType = properties.impactedField,",
            "    lastUpdated = properties.lastUpdated",
          ].join("\n")
        : [
            "advisorresources",
            "| where type == 'microsoft.advisor/recommendations'",
            "| where properties.category =~ 'Cost'",
            "| project id, name, resourceGroup,",
            "    category = properties.category,",
            "    problem = properties.shortDescription.problem,",
            "    solution = properties.shortDescription.solution,",
            "    affectedResource = properties.impactedValue,",
            "    affectedResourceType = properties.impactedField,",
            "    lastUpdated = properties.lastUpdated",
          ].join("\n");

      const [healthResult, activityResult, advisorResult, rbacAssignmentResult, rbacFailuresResult] = await Promise.all([
        batchResourceHealth(subscription, resourceGroup),
        getActivityLogs(subscription, 24, undefined, resourceGroup),
        queryResourceGraph([subscription], advisorQuery),
        queryRoleAssignments(subscription),
        queryRbacActivityFailures(subscription, 24),
      ]);

      // 3. Process Resource Health findings
      if (healthResult.error) {
        errors.push(healthResult.error);
      } else {
        for (const status of healthResult.statuses) {
          const state = status.properties?.availabilityState;
          const resourceName = status.name ?? status.id ?? "unknown";
          const resourceType = status.type ?? "unknown";
          const reasonType = status.properties?.reasonType ?? "";
          const isUserInitiated = reasonType.toLowerCase().includes("userinit") ||
            (status.properties?.summary ?? "").toLowerCase().includes("authorized user");

          if (state === "Unavailable") {
            // User-initiated stops are not incidents
            if (isUserInitiated) {
              findings.push({
                severity: "info",
                resource: resourceName,
                resourceType,
                category: "Resource Health",
                issue: `Resource stopped by authorized user`,
                evidence: { availabilityState: state, reasonType },
                recommendation: "No action needed if intentional.",
              });
            } else {
              findings.push({
                severity: "critical",
                resource: resourceName,
                resourceType,
                category: "Resource Health",
                issue: `Resource is unavailable: ${status.properties?.summary ?? "No details"}`,
                evidence: {
                  availabilityState: state,
                  reasonType,
                  detailedStatus: status.properties?.detailedStatus,
                },
                recommendation:
                  status.properties?.recommendedActions?.[0]?.action ??
                  "Check Azure Service Health for platform events, then review recent changes.",
              });
            }
          } else if (state === "Degraded") {
            findings.push({
              severity: "critical",
              resource: resourceName,
              resourceType,
              category: "Resource Health",
              issue: `Resource is degraded: ${status.properties?.summary ?? "No details"}`,
              evidence: { availabilityState: state, reasonType },
              recommendation:
                "Investigate recent deployments or configuration changes. Check dependent resources.",
            });
          }
        }
      }

      // 4. Process Activity Log findings
      if (activityResult.error) {
        errors.push(activityResult.error);
      } else {
        const changesByResource = new Map<string, number>();

        for (const event of activityResult.events) {
          const resId = event.resourceId ?? "unknown";
          changesByResource.set(resId, (changesByResource.get(resId) ?? 0) + 1);

          if (
            event.status?.value === "Failed" &&
            event.operationName?.value?.includes("deployments")
          ) {
            const resourceName = event.resourceId?.split("/").pop() ?? "unknown";
            findings.push({
              severity: "warning",
              resource: resourceName,
              resourceType: "Microsoft.Resources/deployments",
              category: "Activity Log",
              issue: `Failed deployment: ${event.operationName?.localizedValue ?? event.operationName?.value ?? "unknown operation"}`,
              evidence: {
                status: event.status?.value,
                timestamp: event.eventTimestamp?.toISOString(),
                caller: event.caller,
              },
              recommendation:
                "Review deployment logs for error details. Check ARM template or deployment parameters.",
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
              category: "Activity Log",
              issue: `High change velocity: ${count} changes in last 24h`,
              evidence: { changeCount: count, resourceId: resId },
              recommendation:
                "Review whether repeated changes indicate a flapping deployment or configuration drift.",
            });
          }
        }
      }

      // 5. Process Azure Advisor — only Cost findings (waste/savings).
      // HA, Security, Performance, OpEx recommendations are best-practice noise
      // in a health check context. Use the dedicated azdoctor_advisor tool for those.
      if (advisorResult.error) {
        errors.push(advisorResult.error);
      } else {
        for (const rec of advisorResult.resources) {
          const category = String(rec["category"] ?? "Unknown");
          if (category.toLowerCase() !== "cost") continue;

          const problem = String(rec["problem"] ?? "");
          const solution = String(rec["solution"] ?? "");
          const affectedResource = String(rec["affectedResource"] ?? "unknown");
          const affectedResourceType = String(rec["affectedResourceType"] ?? "unknown");
          const resourceGroupName = String(rec["resourceGroup"] ?? "");

          findings.push({
            severity: "warning",
            resource: affectedResource,
            resourceType: affectedResourceType,
            category: "Cost",
            issue: problem || "Cost optimization opportunity",
            evidence: {
              advisorCategory: category,
              resourceGroup: resourceGroupName,
              lastUpdated: rec["lastUpdated"],
            },
            recommendation: solution || "Review this resource for potential savings.",
          });
        }
      }

      // 6. RBAC risk findings
      if (rbacAssignmentResult.error) {
        errors.push(rbacAssignmentResult.error);
      } else {
        const assignmentCount = rbacAssignmentResult.totalCount;
        if (assignmentCount > 3900) {
          findings.push({
            severity: "critical",
            resource: subscription,
            resourceType: "Subscription",
            category: "RBAC",
            issue: `Role assignment count (${assignmentCount}/4000) is critically high`,
            evidence: { current: assignmentCount, max: 4000 },
            recommendation: "Remove orphaned and redundant role assignments. Use group-based assignments to consolidate. Run azdoctor_rbac_audit for details.",
          });
        } else if (assignmentCount > 3500) {
          findings.push({
            severity: "warning",
            resource: subscription,
            resourceType: "Subscription",
            category: "RBAC",
            issue: `Role assignment count (${assignmentCount}/4000) is approaching the limit`,
            evidence: { current: assignmentCount, max: 4000 },
            recommendation: "Plan to consolidate role assignments. Run azdoctor_rbac_audit for details.",
          });
        }

        // Detect orphaned assignments
        const orphanedCount = rbacAssignmentResult.assignments.filter(
          (a) => !a.principalType || a.principalType === "" || a.principalType === "Unknown"
        ).length;
        if (orphanedCount > 0) {
          findings.push({
            severity: "warning",
            resource: subscription,
            resourceType: "Subscription",
            category: "RBAC",
            issue: `${orphanedCount} orphaned role assignment(s) reference deleted principals`,
            evidence: { orphanedCount },
            recommendation: "Remove orphaned role assignments to free up quota. Run azdoctor_rbac_audit for details.",
          });
        }
      }

      if (rbacFailuresResult.error) {
        errors.push(rbacFailuresResult.error);
      } else if (rbacFailuresResult.failures.length > 0) {
        findings.push({
          severity: "warning",
          resource: subscription,
          resourceType: "Subscription",
          category: "RBAC",
          issue: `${rbacFailuresResult.failures.length} AuthorizationFailed event(s) in the last 24 hours`,
          evidence: {
            count: rbacFailuresResult.failures.length,
            topFailures: rbacFailuresResult.failures.slice(0, 3).map((f) => ({
              operation: f.operation,
              errorCode: f.errorCode,
              caller: f.caller,
            })),
          },
          recommendation: "Review authorization failures and assign required roles. Run azdoctor_rbac_audit for details.",
        });
      }

      // 7. Filter by severity threshold
      const severityRank: Record<string, number> = {
        critical: 3,
        warning: 2,
        info: 1,
      };
      const minRank = severityRank[severity] ?? 2;
      const filtered = findings.filter(
        (f) => (severityRank[f.severity] ?? 0) >= minRank
      );

      // 7. Calculate risk score (0-100)
      const criticalCount = filtered.filter((f) => f.severity === "critical").length;
      const warningCount = filtered.filter((f) => f.severity === "warning").length;
      const infoCount = filtered.filter((f) => f.severity === "info").length;

      const riskScore = Math.min(
        100,
        criticalCount * 25 + warningCount * 8 + infoCount * 2
      );

      const healthyCount = Math.max(0, scannedResources - criticalCount - warningCount);

      // 8. Group findings by source for summary
      const advisorCount = filtered.filter((f) => f.category?.startsWith("Advisor")).length;
      const healthCount = filtered.filter((f) => f.category === "Resource Health").length;
      const activityCount = filtered.filter((f) => f.category === "Activity Log").length;
      const rbacCount = filtered.filter((f) => f.category === "RBAC").length;

      const response = {
        riskScore,
        summary: `${criticalCount} critical, ${warningCount} warning, ${healthyCount} healthy`,
        sources: {
          resourceHealth: healthCount,
          azureAdvisor: advisorCount,
          activityLog: activityCount,
          rbac: rbacCount,
        },
        findings: filtered,
        scannedResources,
        timestamp: new Date().toISOString(),
        errors: errors.length > 0 ? errors : undefined,
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    }
  );
}
