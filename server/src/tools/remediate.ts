import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import { resolveSubscription, queryResourceGraph } from "../utils/azure-client.js";

// ─── Types ──────────────────────────────────────────────────────────

interface RemediationAction {
  action: string;
  description: string;
  risk: "low" | "medium" | "high";
  reversible: boolean;
  applicableTo: string[]; // resource types
  warning?: string;
}

interface RemediationResponse {
  action: string;
  resource: string;
  resourceType: string;
  dryRun: boolean;
  risk: string;
  warning?: string;
  executed: boolean;
  result?: string;
  error?: string;
  rollbackHint?: string;
}

// ─── Available actions ──────────────────────────────────────────────

const AVAILABLE_ACTIONS: RemediationAction[] = [
  {
    action: "restart",
    description: "Restart the resource. Causes brief downtime.",
    risk: "low",
    reversible: true,
    applicableTo: ["microsoft.web/sites", "microsoft.cache/redis", "microsoft.compute/virtualmachines"],
    warning: "Causes 10-30 seconds of downtime during restart.",
  },
  {
    action: "deallocate",
    description: "Deallocate the VM (stop and release compute resources). Stops billing.",
    risk: "high",
    reversible: true,
    applicableTo: ["microsoft.compute/virtualmachines"],
    warning: "VM will be fully stopped and deallocated. Dynamic public IP will be released. Use 'az vm start' to restart.",
  },
  {
    action: "start",
    description: "Start a stopped/deallocated VM.",
    risk: "low",
    reversible: true,
    applicableTo: ["microsoft.compute/virtualmachines"],
  },
  {
    action: "scale_up",
    description: "Change the resource SKU/tier to a higher performance level.",
    risk: "medium",
    reversible: true,
    applicableTo: [
      "microsoft.web/serverfarms",
      "microsoft.sql/servers/databases",
      "microsoft.cache/redis",
    ],
    warning: "May cause brief connectivity interruption during SKU change.",
  },
  {
    action: "scale_out",
    description: "Increase the instance count for horizontal scaling.",
    risk: "low",
    reversible: true,
    applicableTo: ["microsoft.web/serverfarms"],
  },
  {
    action: "failover",
    description: "Trigger a manual failover to the secondary replica.",
    risk: "high",
    reversible: true,
    applicableTo: [
      "microsoft.sql/servers/databases",
      "microsoft.documentdb/databaseaccounts",
    ],
    warning:
      "Causes brief downtime during failover. Only use for geo-replicated resources.",
  },
  {
    action: "flush_cache",
    description: "Flush all data from the Redis cache.",
    risk: "high",
    reversible: false,
    applicableTo: ["microsoft.cache/redis"],
    warning:
      "All cached data will be permanently lost. Applications may experience cold-start latency.",
  },
];

// ─── az CLI helper ──────────────────────────────────────────────────

function executeAzCommand(
  command: string,
  timeoutMs: number = 60000
): { success: boolean; output: string; error?: string } {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { success: true, output };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return {
      success: false,
      output: "",
      error: e.stderr ?? e.message ?? String(err),
    };
  }
}

// ─── Resource ID parsing helpers ────────────────────────────────────

function parseServerNameFromId(resourceId: string): string | undefined {
  // For SQL databases the ID looks like:
  // /subscriptions/.../resourceGroups/.../providers/Microsoft.Sql/servers/{serverName}/databases/{dbName}
  const parts = resourceId.split("/");
  const serversIdx = parts.findIndex(
    (p) => p.toLowerCase() === "servers"
  );
  if (serversIdx !== -1 && parts.length > serversIdx + 1) {
    return parts[serversIdx + 1];
  }
  return undefined;
}

function parseResourceGroupFromId(resourceId: string): string | undefined {
  const parts = resourceId.split("/");
  const rgIdx = parts.findIndex(
    (p) => p.toLowerCase() === "resourcegroups"
  );
  if (rgIdx !== -1 && parts.length > rgIdx + 1) {
    return parts[rgIdx + 1];
  }
  return undefined;
}

function parseSubscriptionFromId(resourceId: string): string | undefined {
  const parts = resourceId.split("/");
  const subIdx = parts.findIndex(
    (p) => p.toLowerCase() === "subscriptions"
  );
  if (subIdx !== -1 && parts.length > subIdx + 1) {
    return parts[subIdx + 1];
  }
  return undefined;
}

// ─── Action executors ───────────────────────────────────────────────

function executeRestart(
  resourceType: string,
  resourceName: string,
  resourceGroup: string,
  subscription: string
): { success: boolean; output: string; error?: string; rollbackHint: string } {
  const normalizedType = resourceType.toLowerCase();

  if (normalizedType === "microsoft.web/sites") {
    const result = executeAzCommand(
      `az webapp restart --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription}`
    );
    return {
      ...result,
      rollbackHint: "No rollback needed — the app will recover automatically after restart.",
    };
  }

  if (normalizedType === "microsoft.cache/redis") {
    const result = executeAzCommand(
      `az redis force-reboot --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --reboot-type AllNodes`
    );
    return {
      ...result,
      rollbackHint: "No rollback needed — Redis will recover automatically after reboot.",
    };
  }

  if (normalizedType === "microsoft.compute/virtualmachines") {
    const result = executeAzCommand(
      `az vm restart --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription}`,
      120000 // VMs can take up to 2 minutes to restart
    );
    return {
      ...result,
      rollbackHint: "No rollback needed — VM will recover automatically after restart.",
    };
  }

  return {
    success: false,
    output: "",
    error: `Restart is not supported for resource type '${resourceType}'.`,
    rollbackHint: "",
  };
}

function executeDeallocate(
  resourceType: string,
  resourceName: string,
  resourceGroup: string,
  subscription: string
): { success: boolean; output: string; error?: string; rollbackHint: string } {
  if (resourceType.toLowerCase() !== "microsoft.compute/virtualmachines") {
    return { success: false, output: "", error: `Deallocate is only supported for VMs.`, rollbackHint: "" };
  }
  const result = executeAzCommand(
    `az vm deallocate --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription}`,
    180000
  );
  return {
    ...result,
    rollbackHint: `To restart: az vm start --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription}`,
  };
}

function executeStart(
  resourceType: string,
  resourceName: string,
  resourceGroup: string,
  subscription: string
): { success: boolean; output: string; error?: string; rollbackHint: string } {
  if (resourceType.toLowerCase() !== "microsoft.compute/virtualmachines") {
    return { success: false, output: "", error: `Start is only supported for VMs.`, rollbackHint: "" };
  }
  const result = executeAzCommand(
    `az vm start --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription}`,
    180000
  );
  return {
    ...result,
    rollbackHint: `To stop: az vm deallocate --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription}`,
  };
}

function executeScaleUp(
  resourceType: string,
  resourceName: string,
  resourceGroup: string,
  subscription: string,
  scaleTarget: string,
  resourceId: string
): { success: boolean; output: string; error?: string; rollbackHint: string } {
  const normalizedType = resourceType.toLowerCase();

  if (normalizedType === "microsoft.web/serverfarms") {
    // Get current SKU before scaling so we can provide a rollback hint
    const currentSkuResult = executeAzCommand(
      `az appservice plan show --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --query sku.name -o tsv`
    );
    const previousSku = currentSkuResult.success
      ? currentSkuResult.output
      : "unknown";

    const result = executeAzCommand(
      `az appservice plan update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --sku ${scaleTarget}`
    );
    return {
      ...result,
      rollbackHint: `Previous SKU was ${previousSku}. To undo: az appservice plan update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --sku ${previousSku}`,
    };
  }

  if (normalizedType === "microsoft.sql/servers/databases") {
    const serverName = parseServerNameFromId(resourceId);
    if (!serverName) {
      return {
        success: false,
        output: "",
        error:
          "Could not parse SQL server name from resource ID. Provide the full resource ID.",
        rollbackHint: "",
      };
    }

    // Get current service objective before scaling
    const currentObjResult = executeAzCommand(
      `az sql db show --name ${resourceName} --resource-group ${resourceGroup} --server ${serverName} --subscription ${subscription} --query currentServiceObjectiveName -o tsv`
    );
    const previousObjective = currentObjResult.success
      ? currentObjResult.output
      : "unknown";

    const result = executeAzCommand(
      `az sql db update --name ${resourceName} --resource-group ${resourceGroup} --server ${serverName} --subscription ${subscription} --service-objective ${scaleTarget}`,
      120000
    );
    return {
      ...result,
      rollbackHint: `Previous service objective was ${previousObjective}. To undo: az sql db update --name ${resourceName} --resource-group ${resourceGroup} --server ${serverName} --subscription ${subscription} --service-objective ${previousObjective}`,
    };
  }

  if (normalizedType === "microsoft.cache/redis") {
    const currentSkuResult = executeAzCommand(
      `az redis show --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --query sku.name -o tsv`
    );
    const previousSku = currentSkuResult.success
      ? currentSkuResult.output
      : "unknown";

    const result = executeAzCommand(
      `az redis update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --sku ${scaleTarget}`,
      120000
    );
    return {
      ...result,
      rollbackHint: `Previous SKU was ${previousSku}. To undo: az redis update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --sku ${previousSku}`,
    };
  }

  return {
    success: false,
    output: "",
    error: `Scale up is not supported for resource type '${resourceType}'.`,
    rollbackHint: "",
  };
}

function executeScaleOut(
  resourceType: string,
  resourceName: string,
  resourceGroup: string,
  subscription: string,
  scaleTarget: string
): { success: boolean; output: string; error?: string; rollbackHint: string } {
  const normalizedType = resourceType.toLowerCase();

  if (normalizedType === "microsoft.web/serverfarms") {
    // Get current worker count before scaling
    const currentCountResult = executeAzCommand(
      `az appservice plan show --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --query sku.capacity -o tsv`
    );
    const previousCount = currentCountResult.success
      ? currentCountResult.output
      : "unknown";

    const result = executeAzCommand(
      `az appservice plan update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --number-of-workers ${scaleTarget}`
    );
    return {
      ...result,
      rollbackHint: `Previous instance count was ${previousCount}. To undo: az appservice plan update --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --number-of-workers ${previousCount}`,
    };
  }

  return {
    success: false,
    output: "",
    error: `Scale out is not supported for resource type '${resourceType}'.`,
    rollbackHint: "",
  };
}

function executeFailover(
  resourceType: string,
  resourceName: string,
  resourceGroup: string,
  subscription: string,
  resourceId: string
): { success: boolean; output: string; error?: string; rollbackHint: string } {
  const normalizedType = resourceType.toLowerCase();

  if (normalizedType === "microsoft.sql/servers/databases") {
    const serverName = parseServerNameFromId(resourceId);
    if (!serverName) {
      return {
        success: false,
        output: "",
        error:
          "Could not parse SQL server name from resource ID. Provide the full resource ID.",
        rollbackHint: "",
      };
    }

    const result = executeAzCommand(
      `az sql db replica set-partner --name ${resourceName} --resource-group ${resourceGroup} --server ${serverName} --subscription ${subscription} --failover`,
      120000
    );
    return {
      ...result,
      rollbackHint:
        "To fail back, run the same failover command targeting the original primary server.",
    };
  }

  if (normalizedType === "microsoft.documentdb/databaseaccounts") {
    const result = executeAzCommand(
      `az cosmosdb failover-priority-change --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --failover-policies`,
      120000
    );
    return {
      ...result,
      rollbackHint:
        "To fail back, trigger another failover-priority-change reversing the region priorities.",
    };
  }

  return {
    success: false,
    output: "",
    error: `Failover is not supported for resource type '${resourceType}'.`,
    rollbackHint: "",
  };
}

function executeFlushCache(
  resourceType: string,
  resourceName: string,
  resourceGroup: string,
  subscription: string
): { success: boolean; output: string; error?: string; rollbackHint: string } {
  const normalizedType = resourceType.toLowerCase();

  if (normalizedType === "microsoft.cache/redis") {
    const result = executeAzCommand(
      `az redis flush --name ${resourceName} --resource-group ${resourceGroup} --subscription ${subscription} --yes`
    );
    return {
      ...result,
      rollbackHint:
        "This action is NOT reversible. Cached data has been permanently deleted.",
    };
  }

  return {
    success: false,
    output: "",
    error: `Flush cache is not supported for resource type '${resourceType}'.`,
    rollbackHint: "",
  };
}

// ─── Tool registration ──────────────────────────────────────────────

export function registerRemediate(server: McpServer): void {
  server.tool(
    "azdoctor_remediate",
    "Execute safe, reversible remediation actions on Azure resources. Supports restart, scale, failover, and cache flush operations with risk ratings and dry-run mode.",
    {
      resource: z
        .string()
        .describe("Resource name or full Azure resource ID"),
      subscription: z
        .string()
        .optional()
        .describe("Azure subscription ID (auto-detected if omitted)"),
      resourceGroup: z
        .string()
        .optional()
        .describe("Resource group name"),
      action: z
        .enum([
          "restart",
          "scale_up",
          "scale_out",
          "failover",
          "flush_cache",
          "deallocate",
          "start",
          "list_actions",
        ])
        .describe("Remediation action to execute"),
      dryRun: z
        .boolean()
        .default(true)
        .describe(
          "When true (default), shows what would happen without executing. Set to false to actually execute."
        ),
      scaleTarget: z
        .string()
        .optional()
        .describe(
          "Target SKU/tier for scale_up, or instance count for scale_out (e.g., 'P1v3' or '3')"
        ),
    },
    async ({
      resource,
      subscription: subParam,
      resourceGroup,
      action,
      dryRun,
      scaleTarget,
    }) => {
      const subscription = await resolveSubscription(subParam);

      // 1. Resolve resource ID from name if needed
      let resourceId = resource;
      let resourceType = "Unknown";
      let resourceName = resource;
      let resolvedResourceGroup = resourceGroup;

      if (!resource.startsWith("/subscriptions/")) {
        const rgFilter = resourceGroup
          ? `| where resourceGroup =~ '${resourceGroup}'`
          : "";
        const resolveQuery = `Resources | where name =~ '${resource}' ${rgFilter} | project id, name, type, location, resourceGroup | take 1`;
        const resolved = await queryResourceGraph(
          [subscription],
          resolveQuery
        );
        if (resolved.resources.length > 0) {
          const r = resolved.resources[0];
          resourceId = (r.id as string) ?? resource;
          resourceType = (r.type as string) ?? "Unknown";
          resourceName = (r.name as string) ?? resource;
          resolvedResourceGroup =
            (r.resourceGroup as string) ?? resourceGroup;
        } else {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: `Could not resolve resource '${resource}'. Ensure the resource exists and you have Reader access.${
                      resolved.error
                        ? ` Details: ${resolved.error.message}`
                        : ""
                    }`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      } else {
        // Parse resource ID for type, name, and resource group
        const parts = resource.split("/");
        resourceName = parts[parts.length - 1] ?? resource;
        const providerIdx = parts.indexOf("providers");
        if (providerIdx !== -1 && parts.length > providerIdx + 2) {
          resourceType = `${parts[providerIdx + 1]}/${parts[providerIdx + 2]}`;
          // Handle sub-resources like Microsoft.Sql/servers/databases
          if (parts.length > providerIdx + 4) {
            resourceType += `/${parts[providerIdx + 3]}`;
          }
        }
        resolvedResourceGroup =
          parseResourceGroupFromId(resource) ?? resourceGroup;
      }

      const normalizedType = resourceType.toLowerCase();

      // 2. Handle list_actions
      if (action === "list_actions") {
        const applicable = AVAILABLE_ACTIONS.filter((a) =>
          a.applicableTo.includes(normalizedType)
        );

        const response = {
          resource: resourceName,
          resourceType,
          availableActions:
            applicable.length > 0
              ? applicable
              : [],
          message:
            applicable.length > 0
              ? `Found ${applicable.length} available remediation action(s) for ${resourceType}.`
              : `No remediation actions are currently available for resource type '${resourceType}'. Supported types: ${[
                  ...new Set(
                    AVAILABLE_ACTIONS.flatMap((a) => a.applicableTo)
                  ),
                ].join(", ")}`,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }

      // 3. Validate the action is applicable to this resource type
      const actionDef = AVAILABLE_ACTIONS.find((a) => a.action === action);
      if (!actionDef) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: `Unknown action '${action}'.` },
                null,
                2
              ),
            },
          ],
        };
      }

      if (!actionDef.applicableTo.includes(normalizedType)) {
        const applicableActions = AVAILABLE_ACTIONS.filter((a) =>
          a.applicableTo.includes(normalizedType)
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: `Action '${action}' is not applicable to resource type '${resourceType}'.`,
                  availableActions:
                    applicableActions.length > 0
                      ? applicableActions.map((a) => ({
                          action: a.action,
                          description: a.description,
                          risk: a.risk,
                        }))
                      : "No remediation actions available for this resource type.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // 4. Validate required parameters
      if (
        (action === "scale_up" || action === "scale_out") &&
        !scaleTarget
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: `The '${action}' action requires the 'scaleTarget' parameter.`,
                  hint:
                    action === "scale_up"
                      ? "Provide a target SKU/tier, e.g., 'P1v3', 'S3', 'Premium'."
                      : "Provide a target instance count, e.g., '3'.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (!resolvedResourceGroup) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error:
                    "Could not determine the resource group. Please provide the 'resourceGroup' parameter.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const resolvedSubscription =
        parseSubscriptionFromId(resourceId) ?? subscription;

      // 5. Dry run mode — describe what would happen without executing
      if (dryRun) {
        const response: RemediationResponse = {
          action,
          resource: resourceName,
          resourceType,
          dryRun: true,
          risk: actionDef.risk,
          warning: actionDef.warning,
          executed: false,
          result: `DRY RUN: Would execute '${action}' on ${resourceName} (${resourceType}) in resource group '${resolvedResourceGroup}'.${
            scaleTarget ? ` Target: ${scaleTarget}.` : ""
          } Set dryRun to false to execute this action.`,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }

      // 6. Execute the action
      let execResult: {
        success: boolean;
        output: string;
        error?: string;
        rollbackHint: string;
      };

      switch (action) {
        case "restart":
          execResult = executeRestart(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription
          );
          break;
        case "scale_up":
          execResult = executeScaleUp(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription,
            scaleTarget!,
            resourceId
          );
          break;
        case "scale_out":
          execResult = executeScaleOut(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription,
            scaleTarget!
          );
          break;
        case "failover":
          execResult = executeFailover(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription,
            resourceId
          );
          break;
        case "flush_cache":
          execResult = executeFlushCache(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription
          );
          break;
        case "deallocate":
          execResult = executeDeallocate(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription
          );
          break;
        case "start":
          execResult = executeStart(
            resourceType,
            resourceName,
            resolvedResourceGroup,
            resolvedSubscription
          );
          break;
        default:
          execResult = {
            success: false,
            output: "",
            error: `Unhandled action '${action}'.`,
            rollbackHint: "",
          };
      }

      const response: RemediationResponse = {
        action,
        resource: resourceName,
        resourceType,
        dryRun: false,
        risk: actionDef.risk,
        warning: actionDef.warning,
        executed: execResult.success,
        result: execResult.success
          ? `Successfully executed '${action}' on ${resourceName}.${
              execResult.output ? ` Output: ${execResult.output}` : ""
            }`
          : undefined,
        error: execResult.error,
        rollbackHint: execResult.rollbackHint || undefined,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    }
  );
}
