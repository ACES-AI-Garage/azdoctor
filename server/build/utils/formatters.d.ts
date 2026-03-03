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
//# sourceMappingURL=formatters.d.ts.map