/**
 * RCA markdown formatter — produces structured Root Cause Analysis documents.
 */
import type { DiagnosticEvent } from "./correlator.js";
export interface RCAInput {
    resource: string;
    resourceType: string;
    subscription: string;
    incidentStart: string;
    incidentEnd?: string;
    timeline: DiagnosticEvent[];
    rootCause: string;
    impact: {
        duration: string;
        errorRate?: string;
        affectedResources: string[];
    };
    remediationApplied: string[];
    recommendations: string[];
}
/**
 * Format investigation results into a structured RCA markdown document.
 */
export declare function formatRCA(input: RCAInput): string;
/**
 * Format a list of health findings into a summary table.
 */
export declare function formatHealthSummary(findings: Array<{
    severity: string;
    resource: string;
    resourceType: string;
    issue: string;
    recommendation: string;
}>): string;
export interface ErrorSummary {
    totalErrors: number;
    permissionGaps: Array<{
        api: string;
        recommendation: string;
    }>;
    otherErrors: Array<{
        api: string;
        message: string;
    }>;
    message: string;
}
/**
 * Produce a structured error/permissions summary from a list of API errors.
 */
export declare function formatErrorSummary(errors: Array<{
    code: string;
    message: string;
    roleRecommendation?: string;
}>): ErrorSummary;
/**
 * Format a comparison summary between two scopes as a markdown table.
 */
export declare function formatComparisonSummary(scopeA: string, scopeB: string, differences: Array<{
    category: string;
    detail: string;
    severity: string;
}>): string;
export interface TopologyNode {
    name: string;
    type: string;
    health: "Available" | "Degraded" | "Unavailable" | "Unknown";
    isRoot: boolean;
}
/**
 * Render an ASCII dependency graph showing health at each node.
 * Uses horizontal box layout for ≤4 dependencies, vertical list for >4.
 */
export declare function renderTopology(root: TopologyNode, dependencies: TopologyNode[]): string;
/**
 * Generate a Mermaid flowchart showing the resource dependency graph with health status.
 */
export declare function renderMermaidTopology(root: TopologyNode, dependencies: TopologyNode[]): string;
/**
 * Generate a Mermaid timeline diagram showing incident events grouped by phase.
 */
export declare function renderMermaidTimeline(events: Array<{
    time: string;
    event: string;
    source: string;
    severity?: string;
}>): string;
//# sourceMappingURL=formatters.d.ts.map