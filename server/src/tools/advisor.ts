import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  resolveSubscription,
  queryResourceGraph,
} from "../utils/azure-client.js";
import type { AzureError } from "../utils/azure-client.js";

// ─── Types ──────────────────────────────────────────────────────────

interface AdvisorRecommendation {
  category: string;
  impact: string;
  problem: string;
  solution: string;
  affectedResource: string;
  affectedResourceType: string;
  resourceGroup: string;
  lastUpdated: string;
}

interface CorrelatedRecommendation extends AdvisorRecommendation {
  correlated: boolean;
  correlationNote?: string;
}

interface AdvisorSummary {
  subscription: string;
  scope: string;
  totalRecommendations: number;
  byCategory: Record<string, number>;
  byImpact: Record<string, number>;
  recommendations: CorrelatedRecommendation[];
  correlatedCount: number;
  topActions: string[];
  errors?: AzureError[];
}

// ─── Helpers ────────────────────────────────────────────────────────

const IMPACT_ORDER: Record<string, number> = {
  High: 0,
  Medium: 1,
  Low: 2,
};

function sortByImpact(a: AdvisorRecommendation, b: AdvisorRecommendation): number {
  return (IMPACT_ORDER[a.impact] ?? 3) - (IMPACT_ORDER[b.impact] ?? 3);
}

function buildQuery(category: string, resourceGroup?: string): string {
  const lines: string[] = [
    "advisorresources",
    "| where type == 'microsoft.advisor/recommendations'",
  ];

  if (category !== "all") {
    // Advisor stores categories with specific casing; use case-insensitive compare
    lines.push(`| where properties.category =~ '${category}'`);
  }

  if (resourceGroup) {
    lines.push(`| where resourceGroup =~ '${resourceGroup}'`);
  }

  lines.push(
    "| project",
    "    id,",
    "    name,",
    "    resourceGroup,",
    "    category = properties.category,",
    "    impact = properties.impact,",
    "    impactedField = properties.impactedField,",
    "    impactedValue = properties.impactedValue,",
    "    shortDescription = properties.shortDescription.solution,",
    "    problem = properties.shortDescription.problem,",
    "    resourceId = properties.resourceMetadata.resourceId,",
    "    lastUpdated = properties.lastUpdated"
  );

  return lines.join("\n");
}

function parseRecommendations(
  resources: Record<string, unknown>[]
): AdvisorRecommendation[] {
  return resources.map((r) => ({
    category: (r["category"] as string) ?? "Unknown",
    impact: (r["impact"] as string) ?? "Unknown",
    problem: (r["problem"] as string) ?? "",
    solution: (r["shortDescription"] as string) ?? "",
    affectedResource: (r["impactedValue"] as string) ?? "",
    affectedResourceType: (r["impactedField"] as string) ?? "",
    resourceGroup: (r["resourceGroup"] as string) ?? "",
    lastUpdated: (r["lastUpdated"] as string) ?? "",
  }));
}

function correlateWithInvestigation(
  recommendations: AdvisorRecommendation[],
  investigationContext: string
): CorrelatedRecommendation[] {
  let investigation: Record<string, unknown>;
  try {
    investigation = JSON.parse(investigationContext);
  } catch {
    // If the context is not valid JSON, skip correlation
    return recommendations.map((rec) => ({ ...rec, correlated: false }));
  }

  // Extract resource IDs and resource names from investigation context
  const investigatedResources = new Set<string>();
  const investigationText = JSON.stringify(investigation).toLowerCase();

  // Collect resource identifiers from common investigation output shapes
  const resourceId = investigation["resourceId"] as string | undefined;
  if (resourceId) {
    investigatedResources.add(resourceId.toLowerCase());
    // Also extract the resource name (last segment)
    const segments = resourceId.split("/");
    const resourceName = segments[segments.length - 1];
    if (resourceName) investigatedResources.add(resourceName.toLowerCase());
  }

  // Check for findings array (common in healthcheck / investigate output)
  const findings = (investigation["findings"] ?? investigation["results"]) as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(findings)) {
    for (const f of findings) {
      const res = (f["resource"] ?? f["resourceId"] ?? f["resourceName"]) as
        | string
        | undefined;
      if (res) {
        investigatedResources.add(res.toLowerCase());
        const parts = res.split("/");
        investigatedResources.add(parts[parts.length - 1].toLowerCase());
      }
    }
  }

  // Check for dependency chain resources
  const dependencies = investigation["dependencies"] as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(dependencies)) {
    for (const dep of dependencies) {
      const depId = (dep["resourceId"] ?? dep["name"]) as string | undefined;
      if (depId) {
        investigatedResources.add(depId.toLowerCase());
        const parts = depId.split("/");
        investigatedResources.add(parts[parts.length - 1].toLowerCase());
      }
    }
  }

  const hasAnomalies =
    investigationText.includes("anomal") ||
    investigationText.includes("unhealthy") ||
    investigationText.includes("degraded") ||
    investigationText.includes("critical");

  return recommendations.map((rec) => {
    const recResourceLower = rec.affectedResource.toLowerCase();
    const recTypeLower = rec.affectedResourceType.toLowerCase();

    // Direct resource match
    if (
      investigatedResources.has(recResourceLower) ||
      [...investigatedResources].some(
        (ir) => ir.includes(recResourceLower) || recResourceLower.includes(ir)
      )
    ) {
      return {
        ...rec,
        correlated: true,
        correlationNote: `Advisor recommendation directly targets resource "${rec.affectedResource}" which is part of the current investigation.`,
      };
    }

    // Reliability/performance recs when anomalies detected
    if (
      hasAnomalies &&
      (rec.category.toLowerCase() === "reliability" ||
        rec.category.toLowerCase() === "performance")
    ) {
      // Check if the resource type appears in the investigation
      if (investigationText.includes(recTypeLower) || investigationText.includes(recResourceLower)) {
        return {
          ...rec,
          correlated: true,
          correlationNote: `Investigation detected anomalies, and this ${rec.category} recommendation for "${rec.affectedResource}" may be related.`,
        };
      }
    }

    // Cost recommendations for dependency-chain resources
    if (rec.category.toLowerCase() === "cost" && Array.isArray(dependencies)) {
      const depNames = dependencies.map((d) =>
        ((d["resourceId"] ?? d["name"]) as string ?? "").toLowerCase()
      );
      if (
        depNames.some(
          (dn) => dn.includes(recResourceLower) || recResourceLower.includes(dn)
        )
      ) {
        return {
          ...rec,
          correlated: true,
          correlationNote: `Cost recommendation for "${rec.affectedResource}" which is in the dependency chain of the investigated resource.`,
        };
      }
    }

    return { ...rec, correlated: false };
  });
}

function buildTopActions(
  recommendations: CorrelatedRecommendation[],
  count: number = 3
): string[] {
  // Prioritize correlated recommendations, then sort by impact
  const sorted = [...recommendations].sort((a, b) => {
    // Correlated first
    if (a.correlated && !b.correlated) return -1;
    if (!a.correlated && b.correlated) return 1;
    // Then by impact
    return sortByImpact(a, b);
  });

  return sorted.slice(0, count).map((rec) => {
    const resource = rec.affectedResource || "unknown resource";
    const detail = rec.solution || rec.problem || "Review recommendation";
    return `${rec.impact.toUpperCase()}: ${detail} for ${resource} (${rec.category})`;
  });
}

// ─── Tool Registration ──────────────────────────────────────────────

export function registerAdvisor(server: McpServer): void {
  server.tool(
    "azdoctor_advisor",
    "Pull Azure Advisor recommendations for a subscription or resource. Correlates Advisor findings with live diagnostic data to prioritize actionable improvements across reliability, security, performance, cost, and operational excellence.",
    {
      subscription: z
        .string()
        .optional()
        .describe("Azure subscription ID (auto-detected if omitted)"),
      resourceGroup: z
        .string()
        .optional()
        .describe("Scope to a specific resource group"),
      category: z
        .enum([
          "all",
          "reliability",
          "security",
          "performance",
          "cost",
          "operationalexcellence",
        ])
        .default("all")
        .describe("Filter by Advisor recommendation category"),
      investigationContext: z
        .string()
        .optional()
        .describe(
          "JSON output from a prior azdoctor_investigate call — correlates Advisor recs with live findings"
        ),
    },
    async ({ subscription, resourceGroup, category, investigationContext }) => {
      const errors: AzureError[] = [];

      // Resolve subscription
      let subscriptionId: string;
      try {
        subscriptionId = await resolveSubscription(subscription);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error:
                    err instanceof Error
                      ? err.message
                      : "Failed to resolve subscription",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 1: Query Advisor via Resource Graph
      const query = buildQuery(category, resourceGroup);
      const graphResult = await queryResourceGraph([subscriptionId], query);

      if (graphResult.error) {
        errors.push(graphResult.error);
      }

      // Step 2: Parse and structure results
      const rawRecommendations = parseRecommendations(graphResult.resources);
      rawRecommendations.sort(sortByImpact);

      // Step 3: Correlate with investigation context
      let recommendations: CorrelatedRecommendation[];
      if (investigationContext) {
        recommendations = correlateWithInvestigation(
          rawRecommendations,
          investigationContext
        );
      } else {
        recommendations = rawRecommendations.map((rec) => ({
          ...rec,
          correlated: false,
        }));
      }

      // Step 4: Build summary
      const byCategory: Record<string, number> = {};
      const byImpact: Record<string, number> = {};
      for (const rec of recommendations) {
        byCategory[rec.category] = (byCategory[rec.category] ?? 0) + 1;
        byImpact[rec.impact] = (byImpact[rec.impact] ?? 0) + 1;
      }

      const correlatedCount = recommendations.filter((r) => r.correlated).length;
      const topActions = buildTopActions(recommendations);

      const summary: AdvisorSummary = {
        subscription: subscriptionId,
        scope: resourceGroup ?? "subscription",
        totalRecommendations: recommendations.length,
        byCategory,
        byImpact,
        recommendations,
        correlatedCount,
        topActions,
        ...(errors.length > 0 ? { errors } : {}),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }
  );
}
