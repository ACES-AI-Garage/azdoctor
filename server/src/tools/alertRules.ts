import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
} from "../utils/azure-client.js";
import { getMetricConfig } from "../utils/metric-config.js";

interface AlertRecommendation {
  name: string;
  metricName: string;
  operator: "GreaterThan" | "LessThan" | "GreaterOrLessThan";
  threshold: number;
  windowSize: string;
  frequency: string;
  severity: 0 | 1 | 2 | 3 | 4;
  description: string;
}

const ALERT_TEMPLATES: Record<string, AlertRecommendation[]> = {
  "microsoft.web/sites": [
    {
      name: "High Error Rate",
      metricName: "Http5xx",
      operator: "GreaterThan",
      threshold: 10,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 1,
      description: "Triggers when HTTP 5xx errors exceed 10 in 5 minutes",
    },
    {
      name: "Slow Response Time",
      metricName: "HttpResponseTime",
      operator: "GreaterThan",
      threshold: 5,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when average response time exceeds 5 seconds",
    },
    {
      name: "High CPU",
      metricName: "CpuPercentage",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when CPU exceeds 85% for 5 minutes",
    },
    {
      name: "High Memory",
      metricName: "MemoryPercentage",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when memory exceeds 85% for 5 minutes",
    },
    {
      name: "Health Check Failures",
      metricName: "HealthCheckStatus",
      operator: "LessThan",
      threshold: 100,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 1,
      description: "Triggers when health check success rate drops below 100%",
    },
  ],
  "microsoft.sql/servers/databases": [
    {
      name: "High DTU Usage",
      metricName: "dtu_consumption_percent",
      operator: "GreaterThan",
      threshold: 90,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when DTU consumption exceeds 90%",
    },
    {
      name: "Connection Failures",
      metricName: "connection_failed",
      operator: "GreaterThan",
      threshold: 5,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 1,
      description: "Triggers when failed connections exceed 5 in 5 minutes",
    },
    {
      name: "Deadlocks",
      metricName: "deadlock",
      operator: "GreaterThan",
      threshold: 1,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers on any deadlock occurrence",
    },
    {
      name: "High Storage Usage",
      metricName: "storage_percent",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT15M",
      frequency: "PT5M",
      severity: 2,
      description: "Triggers when storage exceeds 85%",
    },
  ],
  "microsoft.compute/virtualmachines": [
    {
      name: "High CPU",
      metricName: "Percentage CPU",
      operator: "GreaterThan",
      threshold: 90,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when CPU exceeds 90% for 5 minutes",
    },
    {
      name: "Low Available Memory",
      metricName: "Available Memory Bytes",
      operator: "LessThan",
      threshold: 1073741824,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when available memory drops below 1 GB",
    },
    {
      name: "Disk Queue Depth",
      metricName: "OS Disk Queue Depth",
      operator: "GreaterThan",
      threshold: 10,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when disk queue depth exceeds 10",
    },
  ],
  "microsoft.cache/redis": [
    {
      name: "High Server Load",
      metricName: "serverLoad",
      operator: "GreaterThan",
      threshold: 80,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when Redis server load exceeds 80%",
    },
    {
      name: "High Memory Usage",
      metricName: "usedmemorypercentage",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when memory usage exceeds 85%",
    },
  ],
  "microsoft.containerservice/managedclusters": [
    {
      name: "Node CPU Pressure",
      metricName: "node_cpu_usage_percentage",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when node CPU exceeds 85%",
    },
    {
      name: "Node Memory Pressure",
      metricName: "node_memory_rss_percentage",
      operator: "GreaterThan",
      threshold: 85,
      windowSize: "PT5M",
      frequency: "PT1M",
      severity: 2,
      description: "Triggers when node memory exceeds 85%",
    },
  ],
};

function sanitizeBicepName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function tailorRecommendations(
  recommendations: AlertRecommendation[],
  investigationContext: string
): { recommendations: AlertRecommendation[]; tailored: boolean } {
  let tailored = false;

  try {
    const context = JSON.parse(investigationContext);
    const result = [...recommendations.map((r) => ({ ...r }))];

    // If cascadingFailure is detected, escalate severity on all alerts
    if (context.cascadingFailure === true) {
      tailored = true;
      for (const rec of result) {
        if (rec.severity > 1) {
          rec.severity = (rec.severity - 1) as 0 | 1 | 2 | 3 | 4;
        }
        rec.description += " [Severity escalated due to cascading failure risk]";
      }
    }

    // If diagnosticInsights exist with specific patterns, lower thresholds for sensitivity
    if (Array.isArray(context.diagnosticInsights) && context.diagnosticInsights.length > 0) {
      tailored = true;
      for (const rec of result) {
        if (rec.operator === "GreaterThan") {
          rec.threshold = Math.round(rec.threshold * 0.85);
          rec.description += " [Threshold lowered based on diagnostic insights]";
        } else if (rec.operator === "LessThan") {
          rec.threshold = Math.round(rec.threshold * 1.15);
          rec.description += " [Threshold raised based on diagnostic insights]";
        }
      }
    }

    // If metricTrends show rising trends, add proactive alerts at lower thresholds
    if (Array.isArray(context.metricTrends)) {
      const risingTrends = context.metricTrends.filter(
        (t: { direction?: string }) => t.direction === "rising"
      );
      if (risingTrends.length > 0) {
        tailored = true;
        for (const trend of risingTrends) {
          const metricName = trend.metricName || trend.metric;
          if (!metricName) continue;

          const existing = result.find((r) => r.metricName === metricName);
          if (existing) {
            const proactive: AlertRecommendation = {
              ...existing,
              name: `Proactive: ${existing.name}`,
              threshold:
                existing.operator === "GreaterThan"
                  ? Math.round(existing.threshold * 0.75)
                  : Math.round(existing.threshold * 1.25),
              severity: Math.min(existing.severity + 1, 4) as 0 | 1 | 2 | 3 | 4,
              description: `Early warning: ${existing.description} [Proactive alert based on rising trend]`,
            };
            result.push(proactive);
          }
        }
      }
    }

    return { recommendations: result, tailored };
  } catch {
    // If parsing fails, return originals untailored
    return { recommendations, tailored: false };
  }
}

function generateBicep(
  resourceId: string,
  recommendations: AlertRecommendation[]
): string {
  const lines: string[] = [
    "// Auto-generated by AZ Doctor",
    "// Deploy: az deployment group create -g {resourceGroup} -f alerts.bicep",
    "",
    `param resourceId string = '${resourceId}'`,
    "param actionGroupId string = '' // Set to your Action Group resource ID",
    "",
  ];

  for (const rec of recommendations) {
    const sanitized = sanitizeBicepName(rec.name);
    lines.push(
      `resource alert_${sanitized} 'Microsoft.Insights/metricAlerts@2018-03-01' = {`,
      `  name: 'azdoctor-${rec.name.replace(/'/g, "")}'`,
      `  location: 'global'`,
      `  properties: {`,
      `    severity: ${rec.severity}`,
      `    enabled: true`,
      `    scopes: [resourceId]`,
      `    evaluationFrequency: '${rec.frequency}'`,
      `    windowSize: '${rec.windowSize}'`,
      `    criteria: {`,
      `      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'`,
      `      allOf: [`,
      `        {`,
      `          name: '${rec.metricName}'`,
      `          metricName: '${rec.metricName}'`,
      `          operator: '${rec.operator}'`,
      `          threshold: ${rec.threshold}`,
      `          timeAggregation: 'Average'`,
      `          criterionType: 'StaticThresholdCriterion'`,
      `        }`,
      `      ]`,
      `    }`,
      `    actions: actionGroupId != '' ? [{ actionGroupId: actionGroupId }] : []`,
      `  }`,
      `}`,
      ""
    );
  }

  return lines.join("\n");
}

export function registerAlertRules(server: McpServer): void {
  server.tool(
    "azdoctor_alert_rules",
    "Generate Azure Monitor alert rule recommendations based on resource type and investigation findings. Outputs deployable Bicep templates.",
    {
      resource: z
        .string()
        .describe("Resource name or full Azure resource ID"),
      subscription: z
        .string()
        .optional()
        .describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      resourceGroup: z
        .string()
        .optional()
        .describe("Resource group name (helps resolve resource ID faster)"),
      outputFormat: z
        .enum(["recommendations", "bicep"])
        .default("recommendations")
        .describe(
          "Output as recommendations list or as deployable Bicep template"
        ),
      investigationContext: z
        .string()
        .optional()
        .describe(
          "JSON output from a prior azdoctor_investigate call — used to tailor alerts to the specific issues found"
        ),
    },
    async ({
      resource,
      subscription: subParam,
      resourceGroup,
      outputFormat,
      investigationContext,
    }) => {
      const subscription = await resolveSubscription(subParam);

      // Step 1: Resolve resource type
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
          resourceId = r.id as string;
          resourceType = (r.type as string).toLowerCase();
          resourceName = r.name as string;
          resolvedResourceGroup = r.resourceGroup as string;
        } else {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: `Could not find resource '${resource}' in subscription ${subscription}.`,
                    suggestion:
                      "Provide the full resource ID or specify the resourceGroup parameter.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      } else {
        // Parse resource type from full resource ID
        const parts = resource.split("/");
        // Format: /subscriptions/{sub}/resourceGroups/{rg}/providers/{provider}/{type}/{name}
        if (parts.length >= 9) {
          resourceType = `${parts[6]}/${parts[7]}`.toLowerCase();
          resourceName = parts[parts.length - 1];
          resolvedResourceGroup = parts[4];
        }
      }

      // Step 2: Generate alert recommendations
      const templates = ALERT_TEMPLATES[resourceType];
      if (!templates) {
        // Fall back: check if metric config exists but we have no alert templates
        const metricConfig = getMetricConfig(resourceType);
        const availableTypes = Object.keys(ALERT_TEMPLATES).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  resource: resourceName,
                  resourceType,
                  error: `No alert templates available for resource type '${resourceType}'.`,
                  supportedTypes: availableTypes,
                  hasMetricConfig: !!metricConfig,
                  suggestion: metricConfig
                    ? `Metric config exists for this type with metrics: ${metricConfig.names.join(", ")}. Custom alert rules can be crafted manually.`
                    : "This resource type is not yet supported for alert recommendations.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      let recommendations = [...templates.map((t) => ({ ...t }))];
      let tailoredFromInvestigation = false;

      // Step 3: If investigationContext is provided, tailor recommendations
      if (investigationContext) {
        const result = tailorRecommendations(
          recommendations,
          investigationContext
        );
        recommendations = result.recommendations;
        tailoredFromInvestigation = result.tailored;
      }

      // Step 4: Generate output
      const rg = resolvedResourceGroup || "{resourceGroup}";
      const deployCommand = `az deployment group create -g ${rg} -f alerts.bicep`;

      if (outputFormat === "bicep") {
        const bicep = generateBicep(resourceId, recommendations);
        return {
          content: [
            {
              type: "text" as const,
              text: bicep,
            },
          ],
        };
      }

      // Default: recommendations mode
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                resource: resourceName,
                resourceType,
                recommendations,
                tailoredFromInvestigation,
                totalAlerts: recommendations.length,
                deployCommand,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
