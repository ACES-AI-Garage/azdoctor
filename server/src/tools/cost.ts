import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
  getMetrics,
  batchExecute,
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";

// ─── Types ──────────────────────────────────────────────────────────

interface CostFinding {
  category:
    | "unattached_disk"
    | "stopped_vm"
    | "empty_plan"
    | "unassociated_ip"
    | "idle_lb"
    | "oversized_vm";
  resource: string;
  resourceGroup: string;
  detail: string;
  estimatedMonthlyCost?: string;
  recommendation: string;
  savingsEstimate?: string;
}

interface CostAnalysisResult {
  totalFindings: number;
  estimatedMonthlyWaste: string;
  findings: CostFinding[];
  analyzedResources: number;
  lookbackDays: number;
  timestamp: string;
  errors?: AzureError[];
}

// ─── VM downsize mapping ────────────────────────────────────────────

const VM_DOWNSIZE_MAP: Record<string, string> = {
  Standard_D4s_v3: "Standard_D2s_v3",
  Standard_D8s_v3: "Standard_D4s_v3",
  Standard_D16s_v3: "Standard_D8s_v3",
  Standard_D4s_v5: "Standard_D2s_v5",
  Standard_D8s_v5: "Standard_D4s_v5",
  Standard_D16s_v5: "Standard_D8s_v5",
  Standard_E4s_v3: "Standard_E2s_v3",
  Standard_E8s_v3: "Standard_E4s_v3",
  Standard_E4s_v5: "Standard_E2s_v5",
  Standard_E8s_v5: "Standard_E4s_v5",
  Standard_B4ms: "Standard_B2ms",
  Standard_B8ms: "Standard_B4ms",
  Standard_F4s_v2: "Standard_F2s_v2",
  Standard_F8s_v2: "Standard_F4s_v2",
};

// ─── Disk cost estimation ───────────────────────────────────────────

const DISK_COST_PER_GB_MONTH: Record<string, number> = {
  Standard_LRS: 0.05,
  Premium_LRS: 0.12,
  StandardSSD_LRS: 0.075,
};

function estimateDiskMonthlyCost(
  skuName: string | undefined,
  sizeGB: number | undefined
): number {
  const rate = DISK_COST_PER_GB_MONTH[skuName ?? ""] ?? 0.05;
  return rate * (sizeGB ?? 0);
}

// ─── Registration ───────────────────────────────────────────────────

export function registerCost(server: McpServer): void {
  server.tool(
    "azdoctor_cost",
    "Analyze Azure resource costs and identify waste. Detects idle resources, oversized VMs, unattached storage, and recommends right-sizing based on usage metrics.",
    {
      subscription: z
        .string()
        .optional()
        .describe("Azure subscription ID (auto-detected if omitted)"),
      resourceGroup: z
        .string()
        .optional()
        .describe("Scope to a specific resource group"),
      lookbackDays: z
        .number()
        .default(7)
        .describe("Days of metric history to analyze for right-sizing"),
    },
    async ({ subscription: subParam, resourceGroup, lookbackDays }) => {
      const subscription = await resolveSubscription(subParam);
      const findings: CostFinding[] = [];
      const errors: AzureError[] = [];

      const rgFilter = resourceGroup
        ? `resourceGroup =~ '${resourceGroup}' and `
        : "";

      // 1. Run all waste-detection Resource Graph queries in parallel
      const [
        unattachedDisksResult,
        stoppedVmsResult,
        appServicePlansResult,
        unassociatedIpsResult,
        loadBalancersResult,
        runningVmsResult,
      ] = await Promise.all([
        // Unattached disks
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Compute/disks' and properties.diskState == 'Unattached' | project id, name, type, location, resourceGroup, sku_name=tostring(sku.name), diskSizeGB=toint(properties.diskSizeGB)`
        ),
        // Stopped but allocated VMs
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Compute/virtualMachines' and properties.extended.instanceView.powerState.code == 'PowerState/stopped' | project id, name, type, location, resourceGroup, vmSize=tostring(properties.hardwareProfile.vmSize)`
        ),
        // App Service Plans (check for empty ones)
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Web/serverfarms' | project id, name, resourceGroup, sku_name=tostring(sku.name), sku_tier=tostring(sku.tier), numberOfSites=toint(properties.numberOfSites)`
        ),
        // Unassociated Public IPs
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Network/publicIPAddresses' and properties.ipConfiguration == '' | project id, name, resourceGroup, sku_name=tostring(sku.name)`
        ),
        // Load Balancers (check for idle ones)
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Network/loadBalancers' | project id, name, resourceGroup, sku_name=tostring(sku.name), backendPools=properties.backendAddressPools`
        ),
        // Running VMs for right-sizing analysis
        queryResourceGraph(
          [subscription],
          `Resources | where ${rgFilter}type =~ 'Microsoft.Compute/virtualMachines' and properties.extended.instanceView.powerState.code == 'PowerState/running' | project id, name, resourceGroup, vmSize=tostring(properties.hardwareProfile.vmSize)`
        ),
      ]);

      let totalWasteCents = 0;
      let analyzedResources = 0;

      // ── Process unattached disks ────────────────────────────────
      if (unattachedDisksResult.error) {
        errors.push(unattachedDisksResult.error);
      } else {
        for (const disk of unattachedDisksResult.resources) {
          analyzedResources++;
          const skuName = disk.sku_name as string | undefined;
          const sizeGB = disk.diskSizeGB as number | undefined;
          const monthlyCost = estimateDiskMonthlyCost(skuName, sizeGB);
          totalWasteCents += monthlyCost * 100;

          findings.push({
            category: "unattached_disk",
            resource: String(disk.name ?? "unknown"),
            resourceGroup: String(disk.resourceGroup ?? "unknown"),
            detail: `Unattached ${skuName ?? "unknown SKU"} disk, ${sizeGB ?? "?"}GB — incurring storage cost with no VM attached.`,
            estimatedMonthlyCost: `$${monthlyCost.toFixed(2)}`,
            recommendation:
              "Delete the disk if no longer needed, or snapshot it and delete to preserve data at lower cost.",
            savingsEstimate: `~$${Math.round(monthlyCost)}/month`,
          });
        }
      }

      // ── Process stopped (allocated) VMs ─────────────────────────
      if (stoppedVmsResult.error) {
        errors.push(stoppedVmsResult.error);
      } else {
        for (const vm of stoppedVmsResult.resources) {
          analyzedResources++;
          findings.push({
            category: "stopped_vm",
            resource: String(vm.name ?? "unknown"),
            resourceGroup: String(vm.resourceGroup ?? "unknown"),
            detail: `VM is stopped but still allocated (size: ${vm.vmSize ?? "unknown"}). You are paying for reserved compute capacity.`,
            recommendation:
              "Deallocate the VM (Stop + Deallocate) to stop billing for compute, or delete it if no longer needed.",
          });
        }
      }

      // ── Process empty App Service Plans ─────────────────────────
      if (appServicePlansResult.error) {
        errors.push(appServicePlansResult.error);
      } else {
        for (const plan of appServicePlansResult.resources) {
          analyzedResources++;
          const numberOfSites = plan.numberOfSites as number;
          if (numberOfSites === 0) {
            const tier = plan.sku_tier as string | undefined;
            // Free and Shared tiers have no compute cost
            if (tier && tier !== "Free" && tier !== "Shared") {
              findings.push({
                category: "empty_plan",
                resource: String(plan.name ?? "unknown"),
                resourceGroup: String(plan.resourceGroup ?? "unknown"),
                detail: `App Service Plan (${plan.sku_name ?? "unknown"} / ${tier}) has no apps deployed — paying for idle compute.`,
                recommendation:
                  "Delete the App Service Plan if no longer needed, or deploy an app to utilize the reserved capacity.",
              });
            }
          }
        }
      }

      // ── Process unassociated Public IPs ─────────────────────────
      if (unassociatedIpsResult.error) {
        errors.push(unassociatedIpsResult.error);
      } else {
        for (const ip of unassociatedIpsResult.resources) {
          analyzedResources++;
          const skuName = ip.sku_name as string | undefined;
          const isStandard =
            skuName?.toLowerCase() === "standard" ||
            skuName?.toLowerCase() === "standard_v2";
          const monthlyCost = isStandard ? 3.65 : 0;
          if (isStandard) {
            totalWasteCents += monthlyCost * 100;
          }

          findings.push({
            category: "unassociated_ip",
            resource: String(ip.name ?? "unknown"),
            resourceGroup: String(ip.resourceGroup ?? "unknown"),
            detail: `Public IP (${skuName ?? "unknown"} SKU) is not associated with any resource.`,
            estimatedMonthlyCost: isStandard
              ? `$${monthlyCost.toFixed(2)}`
              : undefined,
            recommendation:
              "Delete the public IP if no longer needed. Unassociated Standard IPs incur a monthly charge.",
            savingsEstimate: isStandard
              ? `~$${monthlyCost.toFixed(0)}/month`
              : undefined,
          });
        }
      }

      // ── Process idle Load Balancers ─────────────────────────────
      if (loadBalancersResult.error) {
        errors.push(loadBalancersResult.error);
      } else {
        for (const lb of loadBalancersResult.resources) {
          analyzedResources++;
          const backendPools = lb.backendPools as unknown[];
          const isEmpty =
            !backendPools ||
            !Array.isArray(backendPools) ||
            backendPools.length === 0;

          if (isEmpty) {
            findings.push({
              category: "idle_lb",
              resource: String(lb.name ?? "unknown"),
              resourceGroup: String(lb.resourceGroup ?? "unknown"),
              detail: `Load Balancer (${lb.sku_name ?? "unknown"} SKU) has no backend pools configured — it is not distributing any traffic.`,
              recommendation:
                "Delete the load balancer if no longer needed, or configure backend pools to utilize it.",
            });
          }
        }
      }

      // ── Right-sizing analysis for running VMs ───────────────────
      if (runningVmsResult.error) {
        errors.push(runningVmsResult.error);
      } else {
        // Limit to 10 VMs to avoid rate limits
        const vmsToAnalyze = runningVmsResult.resources.slice(0, 10);
        analyzedResources += vmsToAnalyze.length;

        const metricTasks = vmsToAnalyze.map((vm) => {
          return async () => {
            const resourceId = vm.id as string;
            const vmName = String(vm.name ?? "unknown");
            const vmRg = String(vm.resourceGroup ?? "unknown");
            const vmSize = String(vm.vmSize ?? "unknown");

            const metricsResult = await getMetrics(
              resourceId,
              ["Percentage CPU"],
              lookbackDays * 24,
              "PT1H"
            );

            if (metricsResult.error) {
              errors.push(metricsResult.error);
              return;
            }

            if (!metricsResult.data) return;

            // Calculate average CPU across all time series data points
            let totalCpu = 0;
            let dataPointCount = 0;

            for (const metric of metricsResult.data.metrics) {
              for (const ts of metric.timeseries) {
                for (const dp of ts.data ?? []) {
                  if (dp.average != null) {
                    totalCpu += dp.average;
                    dataPointCount++;
                  }
                }
              }
            }

            if (dataPointCount === 0) return;

            const avgCpu = totalCpu / dataPointCount;
            const downsizeTo = VM_DOWNSIZE_MAP[vmSize];

            if (avgCpu < 10) {
              findings.push({
                category: "oversized_vm",
                resource: vmName,
                resourceGroup: vmRg,
                detail: `VM (${vmSize}) is significantly oversized — average CPU usage is ${avgCpu.toFixed(1)}% over ${lookbackDays} days.`,
                recommendation: downsizeTo
                  ? `Downsize from ${vmSize} to ${downsizeTo}, or consider a B-series burstable VM for this workload.`
                  : `Consider downsizing to a smaller VM size. Current size ${vmSize} is significantly underutilized.`,
                savingsEstimate: downsizeTo
                  ? "~50% compute cost reduction"
                  : undefined,
              });
            } else if (avgCpu < 30) {
              findings.push({
                category: "oversized_vm",
                resource: vmName,
                resourceGroup: vmRg,
                detail: `VM (${vmSize}) is potentially oversized — average CPU usage is ${avgCpu.toFixed(1)}% over ${lookbackDays} days.`,
                recommendation: downsizeTo
                  ? `Consider downsizing from ${vmSize} to ${downsizeTo}.`
                  : `Consider downsizing to a smaller VM size. Current size ${vmSize} appears underutilized.`,
                savingsEstimate: downsizeTo
                  ? "~50% compute cost reduction"
                  : undefined,
              });
            }
          };
        });

        // Execute metric queries in batches of 3 to respect rate limits
        await batchExecute(metricTasks, 3);
      }

      // ── Build response ──────────────────────────────────────────
      const totalWasteDollars = totalWasteCents / 100;

      const result: CostAnalysisResult = {
        totalFindings: findings.length,
        estimatedMonthlyWaste: `$${totalWasteDollars.toFixed(2)}`,
        findings,
        analyzedResources,
        lookbackDays,
        timestamp: new Date().toISOString(),
        errors: errors.length > 0 ? errors : undefined,
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );
}
