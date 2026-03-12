import { z } from "zod";
import { resolveSubscription, queryResourceGraph, batchResourceHealth, getActivityLogs, createMetricsQueryClient, getMetrics, queryLogAnalytics, } from "../utils/azure-client.js";
// ─── Helpers ──────────────────────────────────────────────────────────
const ROLE_RECOMMENDATIONS = {
    resourceGraph: "Assign Reader role — Resource Graph returns only resources the identity can read.",
    resourceHealth: "Assign Reader role on the subscription or resource.",
    activityLog: "Assign Reader role (includes Microsoft.Insights/eventtypes/*).",
    metrics: "Assign Reader role on the target resource.",
    logAnalytics: "Assign Log Analytics Reader on the workspace, or ensure workspace access mode allows resource-context queries.",
};
/** Run a promise with a timeout. Rejects if it exceeds `ms` milliseconds. */
function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
        promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
}
/** Determine whether an error represents a 403 / AuthorizationFailed. */
function isForbidden(err) {
    const e = err;
    if (e.statusCode === 403)
        return true;
    if (e.code === "AuthorizationFailed")
        return true;
    if (typeof e.message === "string" && e.message.includes("AuthorizationFailed"))
        return true;
    return false;
}
function classifyErr(err, context) {
    if (isForbidden(err)) {
        return {
            accessible: false,
            status: "forbidden",
            detail: String(err.message ?? err),
            roleRecommendation: ROLE_RECOMMENDATIONS[context],
        };
    }
    return {
        accessible: false,
        status: "error",
        detail: String(err.message ?? err),
    };
}
// ─── Individual probes ────────────────────────────────────────────────
const TIMEOUT_MS = 15_000;
async function probeResourceGraph(subscription) {
    try {
        const result = await withTimeout(queryResourceGraph([subscription], "Resources | take 1"), TIMEOUT_MS);
        if (result.error) {
            if (result.error.code === "FORBIDDEN") {
                return {
                    accessible: false,
                    status: "forbidden",
                    detail: result.error.message,
                    roleRecommendation: ROLE_RECOMMENDATIONS.resourceGraph,
                };
            }
            return {
                accessible: false,
                status: "error",
                detail: result.error.message,
            };
        }
        return { accessible: true, status: "ok" };
    }
    catch (err) {
        return classifyErr(err, "resourceGraph");
    }
}
async function probeResourceHealth(subscription) {
    try {
        const result = await withTimeout(batchResourceHealth(subscription), TIMEOUT_MS);
        if (result.error) {
            if (result.error.code === "FORBIDDEN") {
                return {
                    accessible: false,
                    status: "forbidden",
                    detail: result.error.message,
                    roleRecommendation: ROLE_RECOMMENDATIONS.resourceHealth,
                };
            }
            return {
                accessible: false,
                status: "error",
                detail: result.error.message,
            };
        }
        return { accessible: true, status: "ok" };
    }
    catch (err) {
        return classifyErr(err, "resourceHealth");
    }
}
async function probeActivityLog(subscription) {
    try {
        const result = await withTimeout(getActivityLogs(subscription, 1), TIMEOUT_MS);
        if (result.error) {
            if (result.error.code === "FORBIDDEN") {
                return {
                    accessible: false,
                    status: "forbidden",
                    detail: result.error.message,
                    roleRecommendation: ROLE_RECOMMENDATIONS.activityLog,
                };
            }
            return {
                accessible: false,
                status: "error",
                detail: result.error.message,
            };
        }
        return { accessible: true, status: "ok" };
    }
    catch (err) {
        return classifyErr(err, "activityLog");
    }
}
async function probeMetrics(resourceId) {
    if (!resourceId) {
        try {
            // We can instantiate the client to verify the credential is valid,
            // but we cannot query metrics without a specific resource ID.
            createMetricsQueryClient();
            return {
                accessible: false,
                status: "requires_resource",
                detail: "MetricsQueryClient created successfully, but a specific resource ID is required to test metric reads. " +
                    "Provide a resource URI when running metric-specific diagnostics.",
            };
        }
        catch (err) {
            return classifyErr(err, "metrics");
        }
    }
    try {
        const result = await withTimeout(getMetrics(resourceId, ["Percentage CPU"], 1), TIMEOUT_MS);
        if (result.error) {
            if (result.error.code === "FORBIDDEN") {
                return {
                    accessible: false,
                    status: "forbidden",
                    detail: result.error.message,
                    roleRecommendation: ROLE_RECOMMENDATIONS.metrics,
                };
            }
            return {
                accessible: false,
                status: "error",
                detail: result.error.message,
            };
        }
        return { accessible: true, status: "ok" };
    }
    catch (err) {
        return classifyErr(err, "metrics");
    }
}
async function probeLogAnalytics(workspaceId) {
    if (!workspaceId) {
        return {
            accessible: false,
            status: "requires_workspace",
            detail: "Log Analytics requires a workspace ID to test. Provide a workspace ID when running log-specific diagnostics.",
            roleRecommendation: ROLE_RECOMMENDATIONS.logAnalytics,
        };
    }
    try {
        const result = await withTimeout(queryLogAnalytics(workspaceId, "AzureActivity | take 1", 1), TIMEOUT_MS);
        if (result.error) {
            if (result.error.code === "FORBIDDEN") {
                return {
                    accessible: false,
                    status: "forbidden",
                    detail: result.error.message,
                    roleRecommendation: ROLE_RECOMMENDATIONS.logAnalytics,
                };
            }
            return {
                accessible: false,
                status: "error",
                detail: result.error.message,
            };
        }
        return { accessible: true, status: "ok" };
    }
    catch (err) {
        return classifyErr(err, "logAnalytics");
    }
}
// ─── Registration ─────────────────────────────────────────────────────
export function registerCheckPermissions(server) {
    server.tool("azdoctor_check_permissions", "Detect what diagnostic data the current credentials can access and recommend role upgrades for fuller diagnostics.", {
        subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
        resourceId: z.string().optional().describe("Optional Azure resource ID to test Metrics API access against"),
        workspaceId: z.string().optional().describe("Optional Log Analytics workspace ID to test query access"),
    }, async ({ subscription: subParam, resourceId, workspaceId }) => {
        const subscription = await resolveSubscription(subParam);
        // Run the testable probes in parallel for speed.
        const [resourceGraph, resourceHealth, activityLog, metrics, logAnalytics] = await Promise.all([
            probeResourceGraph(subscription),
            probeResourceHealth(subscription),
            probeActivityLog(subscription),
            probeMetrics(resourceId),
            probeLogAnalytics(workspaceId),
        ]);
        // Determine overall readiness based on actually-testable APIs
        // (exclude requires_resource / requires_workspace statuses).
        const allChecks = [resourceGraph, resourceHealth, activityLog, metrics, logAnalytics];
        const testableResults = allChecks.filter((r) => r.status !== "requires_resource" && r.status !== "requires_workspace");
        const passCount = testableResults.filter((r) => r.accessible).length;
        let overallReadiness;
        if (testableResults.length === 0) {
            overallReadiness = "none";
        }
        else if (passCount === testableResults.length) {
            overallReadiness = "full";
        }
        else if (passCount > 0) {
            overallReadiness = "partial";
        }
        else {
            overallReadiness = "none";
        }
        // Build actionable recommendations.
        const recommendations = [];
        const checks = { resourceGraph, resourceHealth, activityLog, metrics, logAnalytics };
        for (const [name, result] of Object.entries(checks)) {
            if (result.status === "forbidden" && result.roleRecommendation) {
                recommendations.push(`${name}: ${result.roleRecommendation}`);
            }
        }
        if (overallReadiness === "none") {
            recommendations.push("No APIs are accessible. Verify that your credentials are valid (run 'az login') and that the subscription ID is correct.");
        }
        if (metrics.status === "requires_resource") {
            recommendations.push("Metrics: To fully verify metrics access, run a diagnostic against a specific resource.");
        }
        if (metrics.status === "error") {
            recommendations.push(`Metrics: Access test against the provided resource failed. ${metrics.detail ?? "Check that the resource ID is valid and the metric name is supported."}`);
        }
        if (logAnalytics.status === "requires_workspace") {
            recommendations.push("Log Analytics: To verify workspace access, provide a Log Analytics workspace ID.");
        }
        if (logAnalytics.status === "error") {
            recommendations.push(`Log Analytics: Access test against the provided workspace failed. ${logAnalytics.detail ?? "Check that the workspace ID is valid."}`);
        }
        if (overallReadiness === "full") {
            recommendations.push("All testable APIs are accessible. Your credentials are well-configured for diagnostics.");
        }
        const report = {
            subscription,
            checks,
            overallReadiness,
            recommendations,
        };
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(report, null, 2),
                },
            ],
        };
    });
}
//# sourceMappingURL=checkPermissions.js.map