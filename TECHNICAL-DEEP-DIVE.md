# AZ Doctor — Technical Deep Dive

This document explains everything about AZ Doctor at the level of detail needed to present it, answer technical questions, and extend it. Read this end-to-end and you'll understand the project deeply.

## What AZ Doctor Is

AZ Doctor is an MCP (Model Context Protocol) server that gives AI assistants — GitHub Copilot CLI, VS Code Copilot, Claude Desktop, Cursor — the ability to deeply investigate Azure resource issues. It's a hackathon project for the monthly AI Bash series.

**The core idea:** When an Azure engineer asks "why is my app returning 500 errors?", the AI model needs diagnostic data to reason about the answer. AZ Doctor's job is to gather that data comprehensively — pulling from Resource Health, Activity Logs, Azure Monitor Metrics, Log Analytics, and dependent resources — so the model can produce an accurate diagnosis.

**What makes it different from just using `az` CLI commands:** AZ Doctor dynamically discovers what telemetry each resource emits (via Azure Monitor's metric definitions API), resolves where metrics actually live (CPU/memory for App Services are on the App Service Plan, not the site), parses resource configuration to find actual dependencies (connection strings in app settings), and auto-discovers Log Analytics workspaces. Doing this manually through `az` CLI would take 10+ sequential commands and deep Azure operational knowledge.

## The 6 Tools

### 1. `azdoctor_investigate`

**File:** `server/src/tools/investigate.ts`
**Purpose:** The core tool. Gathers diagnostic data from every available signal for any Azure resource.

**What it does, step by step:**

1. **Resolves the resource** — takes a resource name (e.g., "my-app-service") and finds it via Azure Resource Graph, getting the full resource ID, type, resource group, and properties.

2. **Discovers available metrics dynamically** — calls `listMetricDefinitions()` on the resource. This asks Azure "what metrics does this resource emit?" and returns the full list. AZ Doctor then sorts them by diagnostic relevance (prioritizing CPU, memory, errors, latency, requests, DTU, connections, etc.) and picks the top 15.

3. **Resolves parent resources** — for App Services, CPU and memory metrics live on the App Service Plan, not the site. AZ Doctor reads the `serverFarmId` property from the App Service and discovers/pulls metrics from the Plan too. This is defined in `PARENT_METRIC_RESOURCES` and can be extended for other resource types that have a similar parent-child metric relationship.

4. **Pulls all signals in parallel:**
   - **Resource Health** — is the resource Available, Degraded, or Unavailable?
   - **Activity Log** — recent write operations, deployments, restarts, failures
   - **Metrics** — the dynamically discovered metrics at 5-minute granularity, with current/max/avg/min values and recent trend data points
   - **Parent metrics** — same as above for the parent resource (if applicable)

5. **Discovers actual dependencies** — for App Services, parses the app's `siteConfig.appSettings` looking for connection string patterns (SQL Server hostnames, Redis cache endpoints, Cosmos endpoints, Storage account names). Finds the matching Azure resources via Resource Graph and checks their health. Falls back to scanning for data resources in the same resource group if no connection string references are found.

6. **Queries Log Analytics** — auto-discovers Log Analytics workspaces in the resource group, then runs three queries:
   - Failed requests: operation name, status code, count, average duration
   - Exceptions: exception type, message, count
   - Dependency failures: target, type, result code, count, average duration

7. **Returns raw data** — everything is returned as structured JSON. No "likely cause", no "recommended actions", no analysis. The AI model does the reasoning.

**Parameters:**
- `resource` (required) — resource name or full ID
- `subscription` (optional) — auto-detected from `az account show`
- `resourceGroup` (optional) — helps resolve faster
- `timeframeHours` (default 24) — how far back to look
- `startTime` / `endTime` (optional) — ISO timestamps for incident scoping (replaces timeframeHours)
- `symptom` (optional) — user-described symptom for context

### 2. `azdoctor_healthcheck`

**File:** `server/src/tools/healthcheck.ts`
**Purpose:** Quick overview of a subscription or resource group's health.

**Data sources:**
- **Resource Health** — Unavailable/Degraded resources are flagged as critical. User-initiated stops are downgraded to info (not an incident).
- **Azure Advisor (Cost only)** — pulls cost recommendations via Resource Graph's `advisorresources` table. Only Cost category — HA/Security/Performance are filtered out because they're best-practice noise, not active issues.
- **Activity Log** — failed deployments and high change velocity (>20 changes on a single resource in 24h).

**Risk scoring:** `min(100, critical × 25 + warning × 8 + info × 2)`

### 3. `azdoctor_baseline`

**File:** `server/src/tools/baseline.ts`
**Purpose:** "Is this metric value normal?" — compares current values against 7-day averages using z-scores.

**How it works:**
1. Dynamically discovers metrics (same pattern as investigate)
2. Pulls current period (last 1 hour, PT5M granularity)
3. Pulls baseline period (last 7 days, PT1H granularity)
4. For each metric: computes current value, 7-day mean, 7-day standard deviation, z-score
5. Classifies: |z| < 2 = normal, 2-3 = elevated, >3 = anomalous

### 4. `azdoctor_compare`

**File:** `server/src/tools/compare.ts`
**Purpose:** Diff two environments (resource groups or subscriptions).

**Compares:** resource inventory by type, health status, change velocity (activity log events in last 24h). Reports parity as matched/partial/divergent.

### 5. `azdoctor_remediate`

**File:** `server/src/tools/remediate.ts`
**Purpose:** Execute safe operational actions with dry-run by default.

**Supported actions:** restart (App Service, Redis), scale_up (App Service Plan, SQL, Redis), scale_out (App Service Plan), failover (SQL, Cosmos DB), flush_cache (Redis).

**Safety:** `dryRun: true` by default. Shows risk rating (low/medium/high), expected impact, and rollback hints before execution. The AI model must explicitly set `dryRun: false` after user confirmation.

### 6. `azdoctor_alert_rules`

**File:** `server/src/tools/alertRules.ts`
**Purpose:** Generate monitoring rules with deployable Bicep templates.

**How it works:**
1. Dynamically discovers metrics via `listMetricDefinitions()`
2. Matches against alertable patterns (error rates, CPU, memory, latency, etc.)
3. If `investigationContext` is provided (JSON from a prior investigate call), tailors thresholds based on observed values
4. Generates Bicep template with the actual metric names and appropriate thresholds

## Key Technical Concepts

### Dynamic Metric Discovery

This is the core differentiator. Instead of maintaining a hardcoded list of metrics per resource type, AZ Doctor calls:

```typescript
const defs = await listMetricDefinitions(resourceId);
```

This returns every metric the resource emits (e.g., a SQL Database returns `dtu_consumption_percent`, `cpu_percent`, `connection_failed`, `deadlock`, `storage_percent`, etc.). AZ Doctor then sorts by diagnostic relevance using priority patterns and pulls the top 15.

**Why this matters:** It means AZ Doctor works for ANY Azure resource type without code changes. New Azure services, preview resources, custom metrics — they all work automatically.

### Parent Resource Resolution

Some Azure resources have their key metrics on a parent resource:
- App Service (microsoft.web/sites) → CPU%, Memory% are on the App Service Plan (microsoft.web/serverfarms)

AZ Doctor handles this by reading the resource's `serverFarmId` property and pulling metrics from both the site and the plan. This is defined in:

```typescript
const PARENT_METRIC_RESOURCES = {
  "microsoft.web/sites": { property: "properties.serverFarmId", label: "App Service Plan" },
};
```

### Dependency Discovery

For App Services, AZ Doctor parses `siteConfig.appSettings` to find connection strings referencing SQL servers, Redis caches, Cosmos accounts, and Storage accounts. It extracts hostnames from patterns like:
- `Server=tcp:sql-server-name.database.windows.net`
- `redis-name.redis.cache.windows.net`
- `cosmos-name.documents.azure.com`
- `storage-name.blob.core.windows.net`

Then queries Resource Graph to find the matching Azure resources and checks their health.

### Lazy Azure SDK Loading

The MCP server must start fast (<1 second) for Copilot CLI to connect. Azure SDK packages are large and slow to import. AZ Doctor uses dynamic imports:

```typescript
export async function getCredential(): Promise<TokenCredential> {
  if (!credentialInstance) {
    const { DefaultAzureCredential } = await import("@azure/identity");
    credentialInstance = new DefaultAzureCredential();
  }
  return credentialInstance;
}
```

Azure SDK packages are externalized from the esbuild bundle (`--external:@azure/*`) and loaded from `node_modules` only when a tool is actually invoked. This keeps MCP handshake time at ~0.3 seconds.

### MCP (Model Context Protocol)

MCP is a standard protocol for connecting AI models to external tools. AZ Doctor implements an MCP server that communicates via STDIO (stdin/stdout JSON-RPC). When a user asks a question, the AI model decides which tool to call, sends a JSON-RPC request to the MCP server, and gets structured data back.

**Registration:** Each tool is registered with a name, description, Zod input schema, and handler function. The MCP SDK handles the protocol negotiation.

## File Structure

```
azdoctor/
├── plugin.json                    # Copilot CLI plugin manifest
├── agents/
│   └── azure-diagnostics.agent.md # Agent instructions (Copilot CLI)
├── skills/                        # Copilot CLI skill shortcuts
│   ├── diagnose/SKILL.md
│   ├── healthcheck/SKILL.md
│   └── compare/SKILL.md
├── server/
│   ├── package.json               # Dependencies (Azure SDK, MCP SDK, zod)
│   ├── tsconfig.json
│   ├── build/
│   │   └── index.js               # esbuild bundle (the actual runtime)
│   └── src/
│       ├── index.ts                # Entry point — registers 6 tools
│       ├── tools/
│       │   ├── investigate.ts      # Core diagnostic data gatherer
│       │   ├── healthcheck.ts      # Subscription/RG health scan
│       │   ├── baseline.ts         # Z-score anomaly detection
│       │   ├── compare.ts          # Environment diffing
│       │   ├── remediate.ts        # Safe operational actions
│       │   └── alertRules.ts       # Dynamic alert generation
│       └── utils/
│           ├── azure-client.ts     # Azure SDK wrappers (lazy-loaded)
│           └── formatters.ts       # Output formatting helpers
└── demo/
    ├── infra/                      # Bicep templates for demo environment
    │   ├── main.bicep              # Subscription-level deployment
    │   └── modules/                # App Service, SQL, waste resources
    ├── app/
    │   ├── server.js               # Demo Express app with SQL dependency
    │   └── package.json
    └── scripts/
        ├── generate-load.sh        # Creates cascading SQL failure
        ├── setup.sh                # Deploys everything
        └── teardown.sh             # Cleans up
```

## Azure SDK Dependencies

| Package | Purpose |
|---------|---------|
| `@azure/identity` | DefaultAzureCredential (inherits `az login` session) |
| `@azure/arm-resourcegraph` | Resource Graph queries (find resources, Advisor recs) |
| `@azure/arm-resourcehealth` | Resource Health availability status |
| `@azure/arm-monitor` | Activity Log events |
| `@azure/monitor-query` | Metric definitions, metric values, Log Analytics queries |
| `@modelcontextprotocol/sdk` | MCP server framework |
| `zod` | Input validation for tool parameters |

## Demo Environment

Two resource groups in the BAMI subscription (`30bf1e4b-5f95-497e-8ff6-3d13fb4d6354`):

**`azdoctor-demo-prod`** (the broken environment):
- `app-azdemo-prod-30bf1e4b` — App Service (B1) with Application Insights
- `plan-azdemo-prod-30bf1e4b` — App Service Plan hosting the app
- `sql-azdemo-prod-30bf1e4b` / `sqldb-azdemo-prod` — SQL Server + Basic 5 DTU database
- `log-azdemo-prod-30bf1e4b` — Log Analytics workspace
- `appi-azdemo-prod-30bf1e4b` — Application Insights
- `vm-waste-prod-30bf1e4b` — Stopped VM (cost waste)
- `disk-orphaned-prod` — Unattached disk (cost waste)
- `ip-orphaned-prod` — Orphaned public IP (cost waste)
- `plan-empty-prod-30bf1e4b` — Empty App Service Plan (cost waste)

**`azdoctor-demo-preprod`** (the healthy baseline):
- Same core stack (App Service + SQL + App Insights + Log Analytics) but no waste resources and no load

### The Demo App

`demo/app/server.js` — Express app with Application Insights auto-instrumentation.

Key endpoint: `GET /api/data` — runs a heavy cross-join SQL query. On the 5 DTU Basic database, concurrent requests exhaust DTU capacity, causing SQL timeouts that cascade into HTTP 500 errors. Application Insights tracks these as failed requests, exceptions, and dependency failures.

### The Load Generator

`demo/scripts/generate-load.sh` — creates a 4-phase cascading failure:

1. **Baseline** (2 min) — light traffic, normal metrics
2. **Ramp up** (2 min) — gradually increasing concurrent SQL queries
3. **Database overwhelmed** (4 min) — 20 concurrent heavy SQL queries exhaust 5 DTU, causing timeouts and 500s
4. **Recovery** (2 min) — traffic drops, SQL recovers

### Baseline Traffic

A GitHub Actions workflow (`.github/workflows/baseline-traffic.yml`) sends light traffic every 15 minutes to build 7-day metric baselines for the `baseline` tool.

## Known Limitations

1. **Copilot CLI agent bug** — [Issue #693](https://github.com/github/copilot-cli/issues/693) prevents the `@azure-diagnostics` agent from accessing MCP tools. Workaround: ask Copilot directly without the `@` prefix.

2. **MCP server must be manually registered** — the plugin's MCP config isn't auto-loaded. Users must add the server to `~/.copilot/mcp-config.json` with `type: "stdio"`.

3. **Parent metric resolution** — only App Service → Plan is handled. Other parent-child metric relationships (e.g., VMSS instances) would need entries in `PARENT_METRIC_RESOURCES`.

4. **Dependency discovery** — connection string parsing works for App Services. Other resource types fall back to scanning data resources in the same resource group.

5. **Log Analytics queries** — assume Application Insights tables (`AppRequests`, `AppExceptions`, `AppDependencies`). Resources without App Insights won't have log data.

## How to Extend

**Add a new parent metric resource:** Add an entry to `PARENT_METRIC_RESOURCES` in `investigate.ts`:
```typescript
"microsoft.compute/virtualmachines": { property: "properties.vmss", label: "VM Scale Set" },
```

**Add dependency discovery for another resource type:** Add a branch in the dependency discovery section of `investigate.ts`, similar to the App Service connection string parsing.

**Add a new tool:** Create a new file in `server/src/tools/`, export a `registerXxx(server: McpServer)` function, import and call it in `server/src/index.ts`.

## Questions You Might Get Asked

**Q: How is this different from Azure SRE Agent?**
A: SRE Agent is an always-on autonomous agent billed per Azure Agent Unit 24/7. AZ Doctor is on-demand, zero cost, and uses your existing Copilot license. SRE Agent is the full-time SRE; AZ Doctor is the doctor you visit when something hurts.

**Q: Does it work for resource types you haven't tested?**
A: Yes — because it dynamically discovers metrics. Any resource that emits Azure Monitor metrics will work. The investigate tool doesn't need to know what type of resource it is.

**Q: Why MCP instead of a CLI tool or Azure Function?**
A: MCP lets any AI model use the tools — Copilot, Claude, Cursor. The diagnostic data gathering is separated from the reasoning, which means the tools get better as models get better, without code changes.

**Q: What permissions does it need?**
A: Reader on the subscription. Log Analytics Reader if you want log queries. That's it.

**Q: Why only 6 tools? Didn't it have 18?**
A: We cut it to focus on tools that provide genuine value over what the AI model could do by running `az` CLI commands directly. The remaining 6 each do something the model can't easily replicate — dynamic metric discovery, statistical baselines, dependency chain resolution, safe remediation with dry-run.
