/**
 * Shared metric configuration and dependency mappings for Azure resource types.
 */
export interface MetricConfig {
    names: string[];
    warningPct: number;
    criticalPct: number;
}
/** Common metrics per Azure resource type — used by investigate and RCA tools */
export declare const METRIC_MAP: Record<string, MetricConfig>;
/**
 * Dependency discovery queries by resource type.
 * Each entry maps a resource type to a Resource Graph query template.
 * The placeholder {rg} will be replaced with the actual resource group name.
 */
export interface DependencyQuery {
    description: string;
    query: string;
}
export declare const DEPENDENCY_MAP: Record<string, DependencyQuery[]>;
/**
 * Get the metric config for a resource type (case-insensitive).
 * Applies any threshold overrides from environment variables.
 */
export declare function getMetricConfig(resourceType: string): MetricConfig | undefined;
/**
 * Returns the effective thresholds for all configured resource types,
 * indicating whether each has been overridden via environment variables.
 */
export declare function getEffectiveThresholds(): Record<string, {
    warningPct: number;
    criticalPct: number;
    overridden: boolean;
}>;
/**
 * Get dependency queries for a resource type (case-insensitive).
 * Returns an empty array if no dependencies are configured.
 */
export declare function getDependencyQueries(resourceType: string, resourceGroup: string): DependencyQuery[];
//# sourceMappingURL=metric-config.d.ts.map