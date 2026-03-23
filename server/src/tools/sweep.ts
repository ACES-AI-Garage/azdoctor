import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import {
  batchExecute,
  queryResourceGraph,
  batchResourceHealth,
  getActivityLogs,
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";

interface SubscriptionRanking {
  subscriptionId: string;
  subscriptionName?: string;
  riskScore: number;
  summary: string;
  totalResources: number;
  critical: number;
  warning: number;
}

interface SubscriptionScanResult {
  subscriptionId: string;
  subscriptionName?: string;
  totalResources: number;
  critical: number;
  warning: number;
  riskScore: number;
  errors: AzureError[];
}

export function registerSweep(server: McpServer): void {
  server.tool(
    "azdoctor_sweep",
    "Scan all accessible Azure subscriptions for health issues. Ranks subscriptions by risk score for a portfolio-wide view.",
    {
      severity: z
        .enum(["critical", "warning", "info"])
        .default("warning")
        .describe("Minimum severity threshold for reported findings"),
    },
    async ({ severity }) => {
      const errors: AzureError[] = [];

      // 1. Discover all subscriptions
      let subscriptionIds: string[];
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
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error:
                    "Failed to list subscriptions. Ensure you are logged in with 'az login'.",
                  details: String(err),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (subscriptionIds.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: "No subscriptions found. Run 'az login' first." },
                null,
                2
              ),
            },
          ],
        };
      }

      // Try to get subscription names
      let subscriptionNames: Map<string, string> = new Map();
      try {
        const namesOutput = execSync(
          'az account list --query "[].{id:id, name:name}" -o json',
          {
            encoding: "utf-8",
            timeout: 15000,
            stdio: ["pipe", "pipe", "pipe"],
          }
        ).trim();
        const parsed = JSON.parse(namesOutput) as Array<{
          id: string;
          name: string;
        }>;
        for (const entry of parsed) {
          subscriptionNames.set(entry.id, entry.name);
        }
      } catch {
        // Names are optional; proceed without them
      }

      // 2. For each subscription, run a lightweight health scan (batched, max 3 concurrent)
      // Use a per-subscription timeout to avoid one slow sub blocking everything
      const PER_SUB_TIMEOUT = 20000; // 20 seconds per subscription

      function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
        return Promise.race([
          promise,
          new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
        ]);
      }

      const scanTasks = subscriptionIds.map(
        (subId) => async (): Promise<SubscriptionScanResult> => {
          const subErrors: AzureError[] = [];
          let totalResources = 0;
          let critical = 0;
          let warning = 0;

          // Run Resource Graph and Activity Logs in parallel (skip Resource Health — too slow for sweep)
          const [rgResult, activityResult] = await withTimeout(
            Promise.all([
              queryResourceGraph(
                [subId],
                "Resources | summarize total=count() | extend unhealthy=0"
              ),
              getActivityLogs(subId, 24),
            ]),
            PER_SUB_TIMEOUT,
            [
              { resources: [], totalRecords: 0, error: { code: "TIMEOUT", message: "Resource Graph scan timed out" } },
              { events: [], error: { code: "TIMEOUT", message: "Activity Log scan timed out" } },
            ]
          );

          if (rgResult.error) {
            subErrors.push(rgResult.error);
          } else if (rgResult.resources.length > 0) {
            totalResources = (rgResult.resources[0]["total"] as number) ?? 0;
          }

          if (activityResult.error) {
            subErrors.push(activityResult.error);
          } else {
            for (const event of activityResult.events) {
              if (event.status?.value === "Failed") {
                warning++;
              }
            }
          }

          // Quick Resource Graph check for unhealthy resources (faster than Resource Health API)
          const unhealthyResult = await withTimeout(
            queryResourceGraph(
              [subId],
              "ResourceHealthResources | where properties.availabilityState != 'Available' | summarize critical=count()"
            ),
            10000,
            { resources: [], totalRecords: 0, error: undefined }
          );
          if (!unhealthyResult.error && unhealthyResult.resources.length > 0) {
            critical = (unhealthyResult.resources[0]["critical"] as number) ?? 0;
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
        }
      );

      const scanResults = await batchExecute(scanTasks, 3);

      // 3. Collect all sub-level errors
      for (const result of scanResults) {
        errors.push(...result.errors);
      }

      // 4. Filter by severity threshold and build rankings
      const severityRank: Record<string, number> = {
        critical: 3,
        warning: 2,
        info: 1,
      };
      const minRank = severityRank[severity] ?? 2;

      const rankings: SubscriptionRanking[] = scanResults
        .filter((r) => {
          // Include if it has findings at or above the severity threshold
          if (minRank >= 3) return r.critical > 0;
          if (minRank >= 2) return r.critical > 0 || r.warning > 0;
          return true; // info: include all
        })
        .map((r) => {
          const healthyCount = Math.max(
            0,
            r.totalResources - r.critical - r.warning
          );
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
      const allRankings: SubscriptionRanking[] =
        rankings.length > 0
          ? rankings
          : scanResults
              .map((r) => {
                const healthyCount = Math.max(
                  0,
                  r.totalResources - r.critical - r.warning
                );
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
          { type: "text" as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    }
  );
}
