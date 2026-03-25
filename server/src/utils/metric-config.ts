/**
 * Shared metric configuration and dependency mappings for Azure resource types.
 */

export interface MetricConfig {
  names: string[];
  warningPct: number;
  criticalPct: number;
}

/**
 * Load threshold overrides from environment variables.
 * Format: AZDOCTOR_THRESHOLD_{TYPE}_{LEVEL}
 * Example: AZDOCTOR_THRESHOLD_WARNING=75 (global override)
 * Example: AZDOCTOR_THRESHOLD_VM_WARNING=85 (VM-specific override)
 *
 * Type shortcuts: VM, SQL, APPSERVICE, REDIS, COSMOS, AKS, STORAGE, KEYVAULT, APIM
 */

const TYPE_SHORTCUTS: Record<string, string> = {
  VM: "microsoft.compute/virtualmachines",
  SQL: "microsoft.sql/servers/databases",
  APPSERVICE: "microsoft.web/sites",
  APPPLAN: "microsoft.web/serverfarms",
  REDIS: "microsoft.cache/redis",
  COSMOS: "microsoft.documentdb/databaseaccounts",
  AKS: "microsoft.containerservice/managedclusters",
  STORAGE: "microsoft.storage/storageaccounts",
  KEYVAULT: "microsoft.keyvault/vaults",
  APIM: "microsoft.apimanagement/service",
  SERVICEBUS: "microsoft.servicebus/namespaces",
  EVENTHUB: "microsoft.eventhub/namespaces",
  POSTGRES: "microsoft.dbforpostgresql/flexibleservers",
  MYSQL: "microsoft.dbformysql/flexibleservers",
  APPGW: "microsoft.network/applicationgateways",
  LB: "microsoft.network/loadbalancers",
  FIREWALL: "microsoft.network/azurefirewalls",
  CDN: "microsoft.cdn/profiles",
  COGNITIVE: "microsoft.cognitiveservices/accounts",
  SIGNALR: "microsoft.signalrservice/signalr",
};

interface ThresholdOverrides {
  globalWarning?: number;
  globalCritical?: number;
  perType: Record<string, { warning?: number; critical?: number }>;
}

function loadThresholdOverrides(): ThresholdOverrides {
  const overrides: ThresholdOverrides = { perType: {} };

  // Global overrides
  const globalWarn = process.env.AZDOCTOR_THRESHOLD_WARNING;
  if (globalWarn) overrides.globalWarning = parseInt(globalWarn, 10);

  const globalCrit = process.env.AZDOCTOR_THRESHOLD_CRITICAL;
  if (globalCrit) overrides.globalCritical = parseInt(globalCrit, 10);

  // Per-type overrides
  for (const [shortcut, fullType] of Object.entries(TYPE_SHORTCUTS)) {
    const warn = process.env[`AZDOCTOR_THRESHOLD_${shortcut}_WARNING`];
    const crit = process.env[`AZDOCTOR_THRESHOLD_${shortcut}_CRITICAL`];
    if (warn || crit) {
      overrides.perType[fullType] = {
        warning: warn ? parseInt(warn, 10) : undefined,
        critical: crit ? parseInt(crit, 10) : undefined,
      };
    }
  }

  return overrides;
}

const thresholdOverrides = loadThresholdOverrides();

/** Common metrics per Azure resource type — used by investigate and RCA tools */
export const METRIC_MAP: Record<string, MetricConfig> = {
  // Compute
  "microsoft.web/sites": {
    names: ["Http5xx", "Http4xx", "HttpResponseTime", "CpuPercentage", "MemoryPercentage", "HealthCheckStatus"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.web/serverfarms": {
    names: ["CpuPercentage", "MemoryPercentage", "DiskQueueLength", "HttpQueueLength"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.compute/virtualmachines": {
    names: ["Percentage CPU", "Available Memory Bytes", "OS Disk Queue Depth", "Network In Total", "Network Out Total"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.containerservice/managedclusters": {
    names: ["node_cpu_usage_percentage", "node_memory_rss_percentage", "kube_pod_status_ready"],
    warningPct: 80,
    criticalPct: 90,
  },

  // Databases
  "microsoft.sql/servers/databases": {
    names: ["dtu_consumption_percent", "connection_failed", "deadlock", "storage_percent", "workers_percent"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.documentdb/databaseaccounts": {
    names: ["TotalRequestUnits", "NormalizedRUConsumption", "TotalRequests", "Http429"],
    warningPct: 80,
    criticalPct: 95,
  },
  "microsoft.dbformysql/flexibleservers": {
    names: ["cpu_percent", "memory_percent", "io_consumption_percent", "active_connections", "storage_percent"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.dbforpostgresql/flexibleservers": {
    names: ["cpu_percent", "memory_percent", "storage_percent", "active_connections"],
    warningPct: 80,
    criticalPct: 90,
  },

  // Caching
  "microsoft.cache/redis": {
    names: ["percentProcessorTime", "usedmemorypercentage", "serverLoad", "cacheRead", "cacheWrite", "connectedclients"],
    warningPct: 80,
    criticalPct: 90,
  },

  // Storage
  "microsoft.storage/storageaccounts": {
    names: ["Availability", "SuccessE2ELatency", "SuccessServerLatency", "Transactions"],
    warningPct: 80,
    criticalPct: 90,
  },

  // Networking
  "microsoft.network/applicationgateways": {
    names: ["TotalRequests", "FailedRequests", "ResponseStatus", "HealthyHostCount", "UnhealthyHostCount", "BackendResponseStatus"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.network/loadbalancers": {
    names: ["SnatConnectionCount", "AllocatedSnatPorts", "UsedSnatPorts", "DipAvailability", "VipAvailability"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.network/azurefirewalls": {
    names: ["Throughput", "ApplicationRuleHit", "NetworkRuleHit", "FirewallHealth"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.cdn/profiles": {
    names: ["RequestCount", "ByteHitRatio", "OriginHealthPercentage", "TotalLatency"],
    warningPct: 80,
    criticalPct: 90,
  },

  // Messaging
  "microsoft.servicebus/namespaces": {
    names: ["IncomingRequests", "ServerErrors", "ThrottledRequests", "ActiveMessages", "DeadletteredMessages"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.eventhub/namespaces": {
    names: ["IncomingRequests", "ServerErrors", "ThrottledRequests", "OutgoingMessages", "IncomingBytes"],
    warningPct: 80,
    criticalPct: 90,
  },

  // AI & API
  "microsoft.cognitiveservices/accounts": {
    names: ["TotalCalls", "TotalErrors", "Latency", "SuccessRate"],
    warningPct: 80,
    criticalPct: 90,
  },
  "microsoft.apimanagement/service": {
    names: ["TotalRequests", "FailedRequests", "UnauthorizedRequests", "BackendDuration", "Capacity"],
    warningPct: 80,
    criticalPct: 90,
  },

  // Security
  "microsoft.keyvault/vaults": {
    names: ["ServiceApiHit", "ServiceApiLatency", "Availability", "SaturationShoebox"],
    warningPct: 80,
    criticalPct: 90,
  },

  // SignalR
  "microsoft.signalrservice/signalr": {
    names: ["ConnectionCount", "MessageCount", "ServerLoad", "ConnectionCloseCount"],
    warningPct: 80,
    criticalPct: 90,
  },
};

/**
 * Dependency discovery queries by resource type.
 * Each entry maps a resource type to a Resource Graph query template.
 * The placeholder {rg} will be replaced with the actual resource group name.
 */
export interface DependencyQuery {
  description: string;
  query: string;
}

export const DEPENDENCY_MAP: Record<string, DependencyQuery[]> = {
  "microsoft.web/sites": [
    {
      description: "Databases (SQL, MySQL, PostgreSQL, Cosmos DB)",
      query: "Resources | where resourceGroup =~ '{rg}' and (type =~ 'Microsoft.Sql/servers/databases' or type =~ 'Microsoft.DocumentDB/databaseAccounts' or type =~ 'Microsoft.DBforMySQL/flexibleServers' or type =~ 'Microsoft.DBforPostgreSQL/flexibleServers') | project id, name, type",
    },
    {
      description: "Caches (Redis)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Cache/Redis' | project id, name, type",
    },
    {
      description: "Storage accounts",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Storage/storageAccounts' | project id, name, type",
    },
    {
      description: "Key Vaults",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.KeyVault/vaults' | project id, name, type",
    },
    {
      description: "Service Bus / Event Hub",
      query: "Resources | where resourceGroup =~ '{rg}' and (type =~ 'Microsoft.ServiceBus/namespaces' or type =~ 'Microsoft.EventHub/namespaces') | project id, name, type",
    },
  ],
  "microsoft.compute/virtualmachines": [
    {
      description: "Disks",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Compute/disks' | project id, name, type",
    },
    {
      description: "Network interfaces",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Network/networkInterfaces' | project id, name, type",
    },
    {
      description: "Network security groups",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Network/networkSecurityGroups' | project id, name, type",
    },
  ],
  "microsoft.containerservice/managedclusters": [
    {
      description: "Container registries",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.ContainerRegistry/registries' | project id, name, type",
    },
    {
      description: "Key Vaults",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.KeyVault/vaults' | project id, name, type",
    },
    {
      description: "Storage accounts",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Storage/storageAccounts' | project id, name, type",
    },
  ],
  "microsoft.network/applicationgateways": [
    {
      description: "Backend App Services",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type",
    },
    {
      description: "Backend VMs",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Compute/virtualMachines' | project id, name, type",
    },
  ],
  "microsoft.apimanagement/service": [
    {
      description: "Backend App Services",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type",
    },
    {
      description: "Backend Functions",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' and kind contains 'functionapp' | project id, name, type",
    },
  ],
  "microsoft.sql/servers/databases": [
    {
      description: "Dependent App Services",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type",
    },
  ],
  "microsoft.web/serverfarms": [
    {
      description: "App Services on this plan",
      query: "Resources | where type =~ 'Microsoft.Web/sites' and resourceGroup =~ '{rg}' | project id, name, type",
    },
  ],
  "microsoft.cache/redis": [
    {
      description: "App Services (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type",
    },
  ],
  "microsoft.keyvault/vaults": [
    {
      description: "App Services (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type",
    },
    {
      description: "VMs (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Compute/virtualMachines' | project id, name, type",
    },
  ],
  "microsoft.network/loadbalancers": [
    {
      description: "Backend VMs",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Compute/virtualMachines' | project id, name, type",
    },
  ],
  "microsoft.servicebus/namespaces": [
    {
      description: "App Services (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type",
    },
    {
      description: "Functions (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' and kind contains 'functionapp' | project id, name, type",
    },
  ],
  "microsoft.eventhub/namespaces": [
    {
      description: "App Services (potential consumers)",
      query: "Resources | where resourceGroup =~ '{rg}' and type =~ 'Microsoft.Web/sites' | project id, name, type",
    },
  ],
};

/**
 * Get the metric config for a resource type (case-insensitive).
 * Applies any threshold overrides from environment variables.
 */
export function getMetricConfig(resourceType: string): MetricConfig | undefined {
  const base = METRIC_MAP[resourceType.toLowerCase()];
  if (!base) return undefined;

  const typeOverride = thresholdOverrides.perType[resourceType.toLowerCase()];

  return {
    names: base.names,
    warningPct: typeOverride?.warning ?? thresholdOverrides.globalWarning ?? base.warningPct,
    criticalPct: typeOverride?.critical ?? thresholdOverrides.globalCritical ?? base.criticalPct,
  };
}

/**
 * Returns the effective thresholds for all configured resource types,
 * indicating whether each has been overridden via environment variables.
 */
export function getEffectiveThresholds(): Record<string, { warningPct: number; criticalPct: number; overridden: boolean }> {
  const result: Record<string, { warningPct: number; criticalPct: number; overridden: boolean }> = {};
  for (const [type, config] of Object.entries(METRIC_MAP)) {
    const effective = getMetricConfig(type)!;
    const overridden = effective.warningPct !== config.warningPct || effective.criticalPct !== config.criticalPct;
    result[type] = { warningPct: effective.warningPct, criticalPct: effective.criticalPct, overridden };
  }
  return result;
}

/**
 * Get dependency queries for a resource type (case-insensitive).
 * Returns an empty array if no dependencies are configured.
 */
export function getDependencyQueries(resourceType: string, resourceGroup: string): DependencyQuery[] {
  const queries = DEPENDENCY_MAP[resourceType.toLowerCase()];
  if (!queries) return [];
  return queries.map((q) => ({
    ...q,
    query: q.query.replace(/\{rg\}/g, resourceGroup),
  }));
}
