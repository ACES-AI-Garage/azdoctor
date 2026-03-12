import { z } from "zod";
import { execSync } from "node:child_process";
import { batchExecute, queryResourceGraph, batchResourceHealth, getActivityLogs, } from "../utils/azure-client.js";
export function registerSweep(server) {
    server.tool("azdoctor_sweep", "Scan all accessible Azure subscriptions for health issues. Ranks subscriptions by risk score for a portfolio-wide view.", {
        severity: z
            .enum(["critical", "warning", "info"])
            .default("warning")
            .describe("Minimum severity threshold for reported findings"),
    }, async ({ severity }) => {
        const errors = [];
        // 1. Discover all subscriptions
        let subscriptionIds;
        try {
            const output = execSync('az account list --query "[].id" -o tsv', {
                encoding: "utf-8",
                timeout: 15000,
                stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            subscriptionIds = output
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            error: "Failed to list subscriptions. Ensure you are logged in with 'az login'.",
                            details: String(err),
                        }, null, 2),
                    },
                ],
            };
        }
        if (subscriptionIds.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ error: "No subscriptions found. Run 'az login' first." }, null, 2),
                    },
                ],
            };
        }
        // Try to get subscription names
        let subscriptionNames = new Map();
        try {
            const namesOutput = execSync('az account list --query "[].{id:id, name:name}" -o json', {
                encoding: "utf-8",
                timeout: 15000,
                stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            const parsed = JSON.parse(namesOutput);
            for (const entry of parsed) {
                subscriptionNames.set(entry.id, entry.name);
            }
        }
        catch {
            // Names are optional; proceed without them
        }
        // 2. For each subscription, run a lightweight health scan (batched, max 5 concurrent)
        const scanTasks = subscriptionIds.map((subId) => async () => {
            const subErrors = [];
            let totalResources = 0;
            let critical = 0;
            let warning = 0;
            // Resource Graph: count resources by type
            const rgResult = await queryResourceGraph([subId], "Resources | summarize count()");
            if (rgResult.error) {
                subErrors.push(rgResult.error);
            }
            else if (rgResult.resources.length > 0) {
                totalResources = rgResult.resources[0]["count_"] ?? 0;
            }
            // Batch Resource Health: count unavailable/degraded
            const healthResult = await batchResourceHealth(subId);
            if (healthResult.error) {
                subErrors.push(healthResult.error);
            }
            else {
                for (const status of healthResult.statuses) {
                    const state = status.properties?.availabilityState;
                    if (state === "Unavailable") {
                        critical++;
                    }
                    else if (state === "Degraded") {
                        critical++;
                    }
                }
            }
            // Activity Logs (last 24h): count failed operations
            const activityResult = await getActivityLogs(subId, 24);
            if (activityResult.error) {
                subErrors.push(activityResult.error);
            }
            else {
                for (const event of activityResult.events) {
                    if (event.status?.value === "Failed") {
                        warning++;
                    }
                }
            }
            // Calculate risk score
            const riskScore = Math.min(100, critical * 30 + warning * 10);
            return {
                subscriptionId: subId,
                subscriptionName: subscriptionNames.get(subId),
                totalResources,
                critical,
                warning,
                riskScore,
                errors: subErrors,
            };
        });
        const scanResults = await batchExecute(scanTasks, 5);
        // 3. Collect all sub-level errors
        for (const result of scanResults) {
            errors.push(...result.errors);
        }
        // 4. Filter by severity threshold and build rankings
        const severityRank = {
            critical: 3,
            warning: 2,
            info: 1,
        };
        const minRank = severityRank[severity] ?? 2;
        const rankings = scanResults
            .filter((r) => {
            // Include if it has findings at or above the severity threshold
            if (minRank >= 3)
                return r.critical > 0;
            if (minRank >= 2)
                return r.critical > 0 || r.warning > 0;
            return true; // info: include all
        })
            .map((r) => {
            const healthyCount = Math.max(0, r.totalResources - r.critical - r.warning);
            return {
                subscriptionId: r.subscriptionId,
                subscriptionName: r.subscriptionName,
                riskScore: r.riskScore,
                summary: `${r.critical} critical, ${r.warning} warning, ${healthyCount} healthy`,
                totalResources: r.totalResources,
                critical: r.critical,
                warning: r.warning,
            };
        })
            .sort((a, b) => b.riskScore - a.riskScore);
        // If severity filter removed everything, still show all subscriptions with zero issues
        const allRankings = rankings.length > 0
            ? rankings
            : scanResults
                .map((r) => {
                const healthyCount = Math.max(0, r.totalResources - r.critical - r.warning);
                return {
                    subscriptionId: r.subscriptionId,
                    subscriptionName: r.subscriptionName,
                    riskScore: r.riskScore,
                    summary: `${r.critical} critical, ${r.warning} warning, ${healthyCount} healthy`,
                    totalResources: r.totalResources,
                    critical: r.critical,
                    warning: r.warning,
                };
            })
                .sort((a, b) => b.riskScore - a.riskScore);
        const response = {
            subscriptionsScanned: subscriptionIds.length,
            rankings: allRankings,
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
//# sourceMappingURL=sweep.js.map