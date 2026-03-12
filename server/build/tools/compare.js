import { z } from "zod";
import { resolveSubscription, queryResourceGraph, batchResourceHealth, getActivityLogs, } from "../utils/azure-client.js";
// ─── Helpers ──────────────────────────────────────────────────────────
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isSubscriptionId(scope) {
    return GUID_PATTERN.test(scope);
}
async function gatherScopeSummary(scope, subscription, mode, errors) {
    const isSubScope = isSubscriptionId(scope);
    const effectiveSubscription = isSubScope ? scope : subscription;
    const resourceGroup = isSubScope ? undefined : scope;
    // Build queries based on mode
    const promises = [
        // Resource inventory
        mode === "health"
            ? Promise.resolve({ resources: [], totalRecords: 0 })
            : queryResourceGraph([effectiveSubscription], resourceGroup
                ? `Resources | where resourceGroup =~ '${resourceGroup}' | summarize count() by type`
                : `Resources | summarize count() by type`),
        // Resource Health
        mode === "resources"
            ? Promise.resolve({ statuses: [] })
            : batchResourceHealth(effectiveSubscription, resourceGroup),
        // Activity logs (last 24h)
        mode === "resources"
            ? Promise.resolve({ events: [] })
            : getActivityLogs(effectiveSubscription, 24, undefined, resourceGroup),
    ];
    const [resourceResult, healthResult, activityResult] = await Promise.all(promises);
    // Process resource inventory
    const resourceTypes = {};
    let totalResources = 0;
    if ("resources" in resourceResult) {
        if (resourceResult.error)
            errors.push(resourceResult.error);
        for (const row of resourceResult.resources) {
            const type = String(row.type ?? "unknown");
            const count = Number(row.count_ ?? row.count ?? 1);
            resourceTypes[type] = count;
            totalResources += count;
        }
    }
    // Process health
    let healthy = 0;
    let degraded = 0;
    let unavailable = 0;
    if ("statuses" in healthResult) {
        if (healthResult.error)
            errors.push(healthResult.error);
        for (const status of healthResult.statuses) {
            const state = status.properties?.availabilityState;
            if (state === "Unavailable") {
                unavailable++;
            }
            else if (state === "Degraded") {
                degraded++;
            }
            else {
                healthy++;
            }
        }
    }
    // Process activity logs
    let recentChanges = 0;
    if ("events" in activityResult) {
        if (activityResult.error)
            errors.push(activityResult.error);
        recentChanges = activityResult.events.length;
    }
    return {
        scope,
        totalResources,
        resourceTypes,
        healthSummary: { healthy, degraded, unavailable },
        recentChanges,
    };
}
// ─── Tool registration ───────────────────────────────────────────────
export function registerCompare(server) {
    server.tool("azdoctor_compare", "Compare the health and configuration of two Azure scopes (resource groups or subscriptions). Useful for validating pre-deployment parity or diagnosing environment-specific issues.", {
        scopeA: z
            .string()
            .describe("First scope — resource group name or subscription ID"),
        scopeB: z
            .string()
            .describe("Second scope — resource group name or subscription ID"),
        subscription: z
            .string()
            .optional()
            .describe("Azure subscription ID (auto-detected if omitted). Used when comparing resource groups in the same subscription."),
        mode: z
            .enum(["health", "resources", "full"])
            .default("full")
            .describe("Comparison mode: health-only, resource inventory, or full comparison"),
    }, async ({ scopeA, scopeB, subscription: subParam, mode }) => {
        const subscription = await resolveSubscription(subParam);
        const errors = [];
        // Gather data for both scopes in parallel
        const [summaryA, summaryB] = await Promise.all([
            gatherScopeSummary(scopeA, subscription, mode, errors),
            gatherScopeSummary(scopeB, subscription, mode, errors),
        ]);
        // Detect differences
        const differences = [];
        if (mode !== "health") {
            // Resource types present in A but not B
            const typesA = new Set(Object.keys(summaryA.resourceTypes));
            const typesB = new Set(Object.keys(summaryB.resourceTypes));
            for (const type of typesA) {
                if (!typesB.has(type)) {
                    differences.push({
                        category: "resource_types",
                        detail: `Resource type '${type}' exists in ${scopeA} (count: ${summaryA.resourceTypes[type]}) but not in ${scopeB}`,
                        severity: "warning",
                    });
                }
            }
            for (const type of typesB) {
                if (!typesA.has(type)) {
                    differences.push({
                        category: "resource_types",
                        detail: `Resource type '${type}' exists in ${scopeB} (count: ${summaryB.resourceTypes[type]}) but not in ${scopeA}`,
                        severity: "warning",
                    });
                }
            }
            // Resource count mismatch for shared types (>20% difference)
            for (const type of typesA) {
                if (typesB.has(type)) {
                    const countA = summaryA.resourceTypes[type];
                    const countB = summaryB.resourceTypes[type];
                    const max = Math.max(countA, countB);
                    const diff = Math.abs(countA - countB);
                    if (max > 0 && diff / max > 0.2) {
                        differences.push({
                            category: "resource_types",
                            detail: `Resource type '${type}' count differs: ${scopeA} has ${countA}, ${scopeB} has ${countB} (${Math.round((diff / max) * 100)}% difference)`,
                            severity: "info",
                        });
                    }
                }
            }
        }
        if (mode !== "resources") {
            // Health differences: one scope has unhealthy resources, other doesn't
            const unhealthyA = summaryA.healthSummary.degraded + summaryA.healthSummary.unavailable;
            const unhealthyB = summaryB.healthSummary.degraded + summaryB.healthSummary.unavailable;
            if ((unhealthyA > 0 && unhealthyB === 0) ||
                (unhealthyB > 0 && unhealthyA === 0)) {
                const affectedScope = unhealthyA > 0 ? scopeA : scopeB;
                const unhealthyCount = Math.max(unhealthyA, unhealthyB);
                differences.push({
                    category: "health",
                    detail: `${affectedScope} has ${unhealthyCount} unhealthy resource(s) while the other scope has none`,
                    severity: "critical",
                });
            }
            else if (unhealthyA > 0 && unhealthyB > 0) {
                differences.push({
                    category: "health",
                    detail: `Both scopes have unhealthy resources: ${scopeA} has ${unhealthyA}, ${scopeB} has ${unhealthyB}`,
                    severity: "critical",
                });
            }
            // Change velocity difference (>3x)
            const changesA = summaryA.recentChanges;
            const changesB = summaryB.recentChanges;
            const minChanges = Math.min(changesA, changesB);
            const maxChanges = Math.max(changesA, changesB);
            if (minChanges > 0 && maxChanges / minChanges > 3) {
                const higherScope = changesA > changesB ? scopeA : scopeB;
                differences.push({
                    category: "change_velocity",
                    detail: `${higherScope} has significantly more activity (${maxChanges} events) compared to the other scope (${minChanges} events) — ${Math.round(maxChanges / minChanges)}x difference`,
                    severity: "warning",
                });
            }
            else if (minChanges === 0 && maxChanges > 0) {
                const higherScope = changesA > changesB ? scopeA : scopeB;
                differences.push({
                    category: "change_velocity",
                    detail: `${higherScope} has ${maxChanges} recent activity event(s) while the other scope has none`,
                    severity: "warning",
                });
            }
        }
        // Parity scoring
        const hasCritical = differences.some((d) => d.severity === "critical");
        const hasWarning = differences.some((d) => d.severity === "warning");
        let parity;
        if (hasCritical) {
            parity = "divergent";
        }
        else if (hasWarning) {
            parity = "partial";
        }
        else {
            parity = "matched";
        }
        const response = {
            scopeA: summaryA,
            scopeB: summaryB,
            differences,
            parity,
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
//# sourceMappingURL=compare.js.map