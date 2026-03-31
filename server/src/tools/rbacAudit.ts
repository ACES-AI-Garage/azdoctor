import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryRoleAssignments,
  queryCustomRoleDefinitions,
  queryRbacActivityFailures,
  getRecommendedRoleForOperation,
} from "../utils/azure-client.js";
import type { AzureError, RoleAssignmentInfo } from "../utils/azure-client.js";

interface RbacFinding {
  severity: "critical" | "warning" | "info";
  category: string;
  issue: string;
  evidence: Record<string, unknown>;
  recommendation: string;
}

export function registerRbacAudit(server: McpServer): void {
  server.tool(
    "azdoctor_rbac_audit",
    "Audit Azure RBAC role assignments and custom roles for a subscription. Detects orphaned assignments, approaching limits, recent authorization failures, unused custom roles, and redundant assignments.",
    {
      subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z.string().optional().describe("Scope to a specific resource group"),
      principal: z.string().optional().describe("User/SP/MI object ID to focus analysis on"),
      symptom: z.string().optional().describe("Free-text symptom description (e.g. 'access denied', 'can't assign role')"),
    },
    async ({ subscription: subParam, resourceGroup, principal, symptom }) => {
      const subscription = await resolveSubscription(subParam);
      const findings: RbacFinding[] = [];
      const errors: AzureError[] = [];

      const scope = resourceGroup
        ? `/subscriptions/${subscription}/resourcegroups/${resourceGroup}`
        : undefined;

      // ── 1. Query role assignments and custom roles in parallel ────
      const [assignmentResult, customRoleResult, rbacFailuresResult] = await Promise.all([
        queryRoleAssignments(subscription, scope),
        queryCustomRoleDefinitions(subscription),
        queryRbacActivityFailures(subscription, 24),
      ]);

      if (assignmentResult.error) errors.push(assignmentResult.error);
      if (customRoleResult.error) errors.push(customRoleResult.error);
      if (rbacFailuresResult.error) errors.push(rbacFailuresResult.error);

      const assignments = assignmentResult.assignments;
      const customRoles = customRoleResult.roles;

      // ── 2. Role assignment count vs 4000 limit ───────────────────
      const assignmentCount = assignmentResult.totalCount;
      const ASSIGNMENT_LIMIT = 4000;
      if (assignmentCount > 3900) {
        findings.push({
          severity: "critical",
          category: "Role Assignment Limit",
          issue: `Role assignment count (${assignmentCount}) is critically close to the ${ASSIGNMENT_LIMIT} limit`,
          evidence: { current: assignmentCount, max: ASSIGNMENT_LIMIT },
          recommendation: "Immediately remove orphaned and redundant role assignments. Use group-based assignments to consolidate.",
        });
      } else if (assignmentCount > 3500) {
        findings.push({
          severity: "warning",
          category: "Role Assignment Limit",
          issue: `Role assignment count (${assignmentCount}) is approaching the ${ASSIGNMENT_LIMIT} limit`,
          evidence: { current: assignmentCount, max: ASSIGNMENT_LIMIT },
          recommendation: "Plan to consolidate role assignments using Azure AD groups or remove unused assignments.",
        });
      }

      // ── 3. Custom role definition count vs 5000 limit ────────────
      const customRoleCount = customRoleResult.totalCount;
      const CUSTOM_ROLE_LIMIT = 5000;
      if (customRoleCount > 4900) {
        findings.push({
          severity: "critical",
          category: "Custom Role Limit",
          issue: `Custom role definition count (${customRoleCount}) is critically close to the ${CUSTOM_ROLE_LIMIT} limit`,
          evidence: { current: customRoleCount, max: CUSTOM_ROLE_LIMIT },
          recommendation: "Remove unused custom role definitions. Consolidate similar roles.",
        });
      } else if (customRoleCount > 4500) {
        findings.push({
          severity: "warning",
          category: "Custom Role Limit",
          issue: `Custom role definition count (${customRoleCount}) is approaching the ${CUSTOM_ROLE_LIMIT} limit`,
          evidence: { current: customRoleCount, max: CUSTOM_ROLE_LIMIT },
          recommendation: "Review custom roles for consolidation opportunities.",
        });
      }

      // ── 4. Orphaned role assignments ─────────────────────────────
      const orphaned = assignments.filter(
        (a) => !a.principalType || a.principalType === "" || a.principalType === "Unknown"
      );
      if (orphaned.length > 0) {
        findings.push({
          severity: "warning",
          category: "Orphaned Role Assignment",
          issue: `${orphaned.length} role assignment(s) reference deleted or unknown principals`,
          evidence: {
            count: orphaned.length,
            orphanedAssignments: orphaned.slice(0, 10).map((a) => ({
              id: a.id,
              principalId: a.principalId,
              scope: a.scope,
            })),
          },
          recommendation: "Remove orphaned role assignments to free up quota and reduce security risk.",
        });
      }

      // ── 5. Redundant role assignments ────────────────────────────
      // Same principal + same roleDefinitionId at multiple scopes
      const principalRoleMap = new Map<string, RoleAssignmentInfo[]>();
      for (const a of assignments) {
        const key = `${a.principalId}|${a.roleDefinitionId}`;
        const existing = principalRoleMap.get(key);
        if (existing) {
          existing.push(a);
        } else {
          principalRoleMap.set(key, [a]);
        }
      }
      const redundant = Array.from(principalRoleMap.entries())
        .filter(([, v]) => v.length > 1);
      if (redundant.length > 0) {
        findings.push({
          severity: "info",
          category: "Redundant Role Assignment",
          issue: `${redundant.length} principal(s) have the same role assigned at multiple scopes`,
          evidence: {
            count: redundant.length,
            examples: redundant.slice(0, 5).map(([key, assigns]) => ({
              principalId: assigns[0].principalId,
              roleDefinitionId: assigns[0].roleDefinitionId,
              scopes: assigns.map((a) => a.scope),
            })),
          },
          recommendation: "Review whether broader-scope assignments make narrower ones redundant. Consolidate where appropriate.",
        });
      }

      // ── 6. Unused custom roles ───────────────────────────────────
      const assignedRoleIds = new Set(assignments.map((a) => a.roleDefinitionId));
      const unusedRoles = customRoles.filter(
        (r) => !assignedRoleIds.has(r.id.toLowerCase())
      );
      if (unusedRoles.length > 0) {
        findings.push({
          severity: "info",
          category: "Unused Custom Role",
          issue: `${unusedRoles.length} custom role definition(s) have no active assignments`,
          evidence: {
            count: unusedRoles.length,
            roles: unusedRoles.slice(0, 10).map((r) => ({
              id: r.id,
              roleName: r.roleName,
            })),
          },
          recommendation: "Consider removing unused custom roles to reduce clutter and free up quota.",
        });
      }

      // ── 7. Recent RBAC failures ──────────────────────────────────
      const rbacFailures = rbacFailuresResult.failures;
      if (rbacFailures.length > 0) {
        const criticalCodes = ["RoleAssignmentLimitExceeded", "RoleDefinitionLimitExceeded"];
        const hasCritical = rbacFailures.some((f) => criticalCodes.includes(f.errorCode));
        findings.push({
          severity: hasCritical ? "critical" : "warning",
          category: "Recent RBAC Failure",
          issue: `${rbacFailures.length} RBAC-related failure(s) in the last 24 hours`,
          evidence: {
            count: rbacFailures.length,
            failures: rbacFailures.slice(0, 10),
          },
          recommendation: "Review each failure and apply the recommended role assignments.",
        });
      }

      // ── 8. If principal specified, list their roles ──────────────
      let principalRoles: Record<string, unknown>[] | undefined;
      if (principal) {
        const principalAssignments = assignments.filter(
          (a) => a.principalId === principal
        );
        if (principalAssignments.length === 0) {
          findings.push({
            severity: "warning",
            category: "Principal Access",
            issue: `Principal ${principal} has no direct role assignments in this scope`,
            evidence: { principalId: principal, scope: scope ?? `subscription ${subscription}` },
            recommendation: "Check if the principal has access through group membership, or assign the required role directly.",
          });
        } else {
          principalRoles = principalAssignments.map((a) => ({
            roleDefinitionId: a.roleDefinitionId,
            scope: a.scope,
            principalType: a.principalType,
          }));
        }
      }

      // ── 9. Check for empty/very low assignment count (transfer) ──
      if (assignmentCount === 0) {
        findings.push({
          severity: "critical",
          category: "Subscription Transfer",
          issue: "Subscription has zero role assignments — this may indicate assignments were deleted after a subscription transfer",
          evidence: { assignmentCount: 0 },
          recommendation: "If the subscription was recently transferred, re-create role assignments. See: https://learn.microsoft.com/en-us/azure/role-based-access-control/transfer-subscription",
        });
      } else if (assignmentCount <= 2) {
        findings.push({
          severity: "warning",
          category: "Subscription Transfer",
          issue: `Subscription has only ${assignmentCount} role assignment(s) — unusually low`,
          evidence: { assignmentCount },
          recommendation: "Verify this is expected. If the subscription was recently transferred, role assignments may have been deleted.",
        });
      }

      // ── 10. Cannot delete last Owner check ───────────────────────
      const ownerRoleIdSuffix = "/providers/microsoft.authorization/roledefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
      const ownerAssignments = assignments.filter(
        (a) => a.roleDefinitionId.endsWith(ownerRoleIdSuffix)
      );
      if (ownerAssignments.length === 1) {
        findings.push({
          severity: "warning",
          category: "Last Owner",
          issue: "Only one Owner role assignment exists on the subscription",
          evidence: {
            ownerPrincipalId: ownerAssignments[0].principalId,
            ownerPrincipalType: ownerAssignments[0].principalType,
          },
          recommendation: "Assign at least one additional Owner to prevent lockout if this principal is deleted or disabled.",
        });
      }

      // ── Build response ───────────────────────────────────────────
      const response: Record<string, unknown> = {
        subscription,
        scope: scope ?? `subscription ${subscription}`,
        limits: {
          roleAssignments: {
            current: assignmentCount,
            max: ASSIGNMENT_LIMIT,
            status: assignmentCount > 3900 ? "critical" : assignmentCount > 3500 ? "warning" : "ok",
          },
          customRoles: {
            current: customRoleCount,
            max: CUSTOM_ROLE_LIMIT,
            status: customRoleCount > 4900 ? "critical" : customRoleCount > 4500 ? "warning" : "ok",
          },
        },
        findings,
        recentRbacFailures: rbacFailures.length > 0 ? rbacFailures : undefined,
        principalRoles: principalRoles,
        timestamp: new Date().toISOString(),
        errors: errors.length > 0 ? errors : undefined,
      };

      if (symptom) {
        response.reportedSymptom = symptom;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
