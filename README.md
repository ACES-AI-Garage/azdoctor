# AZ Doctor

**AI-powered Azure diagnostics for GitHub Copilot CLI.**

Ask a question in natural language, get a structured diagnosis backed by live Azure data — resource health, metrics, activity logs, dependencies, and Microsoft Learn docs, all correlated automatically.

## Quick Start

### Prerequisites

- [GitHub Copilot CLI](https://docs.github.com/en/copilot) installed
- Azure CLI logged in (`az login`)
- Node.js 18+

### Install

```
/plugin install ACES-AI-Garage/azdoctor
```

Then install the MCP server dependencies:

**Windows (PowerShell):**
```powershell
cd "$env:USERPROFILE\.copilot\installed-plugins\_direct\ACES-AI-Garage--azdoctor\server"
npm install --omit=dev
```

**macOS / Linux:**
```bash
cd ~/.copilot/installed-plugins/_direct/ACES-AI-Garage--azdoctor/server
npm install --omit=dev
```

Restart Copilot CLI. Verify with `/mcp show azdoctor` — you should see 18 tools.

## Usage

Talk to the `@azure-diagnostics` agent in natural language. Here's what it looks like in practice:

---

**"Check the health of my subscription"**

Scans all resources and returns a risk score with specific findings:

```json
{
  "riskScore": 34,
  "summary": "3 critical, 8 warning, 247 healthy",
  "scannedResources": 258,
  "findings": [
    {
      "severity": "critical",
      "resource": "sqldb-orders-prod",
      "issue": "Resource health: Degraded",
      "recommendation": "Check Azure Status for known issues, review recent changes"
    },
    {
      "severity": "warning",
      "resource": "disk-old-backup",
      "issue": "Unattached managed disk (200 GB, Premium_LRS)",
      "recommendation": "Delete if no longer needed to save ~$27/month"
    }
  ]
}
```

---

**"Why is my app service prod-api returning 500 errors?"**

Correlates health, activity logs, metrics, and dependencies to find the root cause:

```json
{
  "resource": "prod-api",
  "currentHealth": "Degraded",
  "confidence": "high",
  "cascadingFailure": true,
  "likelyCause": "Deployment at 14:23 UTC introduced a breaking change — HTTP 5xx rate jumped from 0.1% to 34% within 2 minutes of deployment completion",
  "diagnosticInsights": [
    { "pattern": "bad_deployment", "confidence": 0.92, "detail": "5xx spike correlates with deployment event at 14:23" }
  ],
  "metricTrends": [
    { "metric": "Http5xx", "direction": "rising", "rSquared": 0.94 }
  ],
  "dependentResources": [
    { "name": "sqldb-orders-prod", "type": "Microsoft.Sql/servers/databases", "health": "Degraded" }
  ],
  "recommendedActions": [
    "Roll back deployment from 14:23 UTC",
    "Investigate SQL dependency — sqldb-orders-prod is also degraded",
    "Review application logs for exception details"
  ]
}
```

---

**"Find cost waste in my subscription"**

Identifies idle resources and right-sizing opportunities:

```json
{
  "totalFindings": 6,
  "estimatedMonthlyWaste": "$847.00",
  "findings": [
    {
      "category": "stopped_vm",
      "resource": "vm-dev-test-03",
      "detail": "VM is stopped but still allocated — compute charges continue",
      "estimatedMonthlyCost": "$312.00",
      "recommendation": "Deallocate the VM or delete if no longer needed"
    },
    {
      "category": "oversized_vm",
      "resource": "vm-batch-worker",
      "detail": "Standard_D8s_v3 averaging 6% CPU over 7 days",
      "recommendation": "Downsize to Standard_D2s_v3 — saves ~$380/month"
    },
    {
      "category": "unattached_disk",
      "resource": "disk-old-snapshot",
      "detail": "Premium SSD 512 GB, unattached",
      "estimatedMonthlyCost": "$73.00",
      "recommendation": "Delete if no longer needed"
    }
  ]
}
```

---

**"Run a full triage on prod-api"**

One command runs the full pipeline — permissions, investigation, baseline, alerts, and saves a report:

```json
{
  "resource": "prod-api",
  "triageDuration": "8.3s",
  "currentHealth": "Degraded",
  "confidence": "high",
  "likelyCause": "Deployment at 14:23 UTC caused 5xx spike",
  "topology": "prod-api (Degraded)\n  ├── sqldb-orders-prod (Degraded)\n  └── redis-session-cache (Available)",
  "baseline": {
    "overallStatus": "anomalous",
    "metrics": [
      { "metric": "CpuPercentage", "current": 89, "mean": 42, "zScore": 3.1, "status": "anomalous" },
      { "metric": "Http5xx", "current": 847, "mean": 12, "zScore": 5.8, "status": "anomalous" }
    ]
  },
  "alertRecommendations": [
    { "name": "High CPU Alert", "metric": "CpuPercentage", "threshold": 85, "description": "CPU exceeded 85% — fire before saturation" }
  ],
  "journalSaved": true,
  "journalPath": "~/.azdoctor/journal/prod-api-2026-03-16T15-30-00Z.md"
}
```

---

More examples of what you can ask:

```
@azure-diagnostics Generate an RCA for the outage on prod-api between 2pm and 4pm UTC today
@azure-diagnostics Compare prod-rg vs staging-rg
@azure-diagnostics Is my prod-api CPU usage normal right now?
@azure-diagnostics Restart prod-api to mitigate the issue
@azure-diagnostics Show me failed requests in the last hour
@azure-diagnostics Send the investigation results to our Teams channel
@azure-diagnostics Generate alert rules for prod-api based on the investigation
@azure-diagnostics Scan all my subscriptions for health issues
```

Four skills are also available as shortcuts: `/diagnose`, `/healthcheck`, `/rca`, `/compare`

## What's Inside

### 18 MCP Tools

**Detect** — find problems before users do

| Tool | What it does |
|------|-------------|
| `azdoctor_healthcheck` | Subscription-wide health scan with 0-100 risk scoring and misconfiguration detection |
| `azdoctor_sweep` | Scan all accessible subscriptions in parallel, ranked by risk |
| `azdoctor_advisor` | Pull Azure Advisor recommendations (reliability, security, performance, cost) |
| `azdoctor_check_permissions` | Verify which Azure APIs your credentials can access |

**Diagnose** — understand what went wrong and why

| Tool | What it does |
|------|-------------|
| `azdoctor_investigate` | Multi-signal correlation: health + logs + metrics + dependencies + trend detection |
| `azdoctor_query` | Natural language to KQL — auto-discovers Log Analytics workspaces |
| `azdoctor_baseline` | "Is this normal?" — compares current metrics against a 7-day baseline |
| `azdoctor_compare` | Diff two resource groups or subscriptions (e.g., prod vs staging) |
| `azdoctor_triage` | Full pipeline in one call: permissions → investigate → baseline → alerts → journal |

**Act** — fix issues and prevent recurrence

| Tool | What it does |
|------|-------------|
| `azdoctor_remediate` | Restart, scale, or failover resources with dry-run mode and risk ratings |
| `azdoctor_alert_rules` | Generate Azure Monitor alert rules with deployable Bicep templates |
| `azdoctor_cost` | Find waste: idle resources, oversized VMs, orphaned storage |

**Report** — document and share findings

| Tool | What it does |
|------|-------------|
| `azdoctor_rca` | Structured Root Cause Analysis (markdown or JSON) |
| `azdoctor_playback` | Incident timeline replay with phase markers for post-incident reviews |
| `azdoctor_diagram` | Mermaid dependency topology and incident timeline diagrams |
| `azdoctor_journal` | Save and retrieve investigation results as local markdown files |
| `azdoctor_notify` | Send summaries to Teams, Slack, or any webhook |
| `azdoctor_playbooks` | Manage custom diagnostic runbooks with trigger-based matching |

All tools auto-detect your subscription from `az CLI` — no subscription ID needed.

### Resource Coverage

Built-in metric profiles and dependency discovery for 21+ resource types:

App Service, App Service Plans, VMs, AKS, SQL Database, Cosmos DB, MySQL Flexible, PostgreSQL Flexible, Redis Cache, Storage Accounts, Application Gateway, Load Balancer, Azure Firewall, CDN, Service Bus, Event Hub, Cognitive Services, API Management, Key Vault, SignalR

For services without built-in profiles, AZ Doctor pulls troubleshooting docs from **Microsoft Learn** at runtime and applies them to live diagnostic data — covering 200+ Azure services without custom code.

### Diagnostic Intelligence

- **11 diagnostic patterns**: bad deployment, memory exhaustion, CPU saturation, health check failure, DTU exhaustion, connection storm, deadlock storm, disk bottleneck, network saturation, platform incident, rapid config changes
- **Metric trend detection** via linear regression with R² confidence
- **Cascading failure detection** via event clustering
- **Confidence scoring** (high/medium/low) based on signal correlation quality

## How It Works

AZ Doctor sits between you and three data sources:

```
You (natural language)
 │
 ▼
┌──────────────────────────────────────────────────┐
│              AZ Doctor MCP Server                 │
│                                                   │
│  Correlates signals, detects patterns,            │
│  generates RCAs, recommends actions               │
├──────────┬──────────────────┬────────────────────┤
│  Azure   │  Microsoft Learn │  Azure Advisor /   │
│  APIs    │  MCP Server      │  Resource Graph    │
│          │                  │                    │
│  Health  │  Troubleshooting │  Recommendations   │
│  Logs    │  guides & docs   │  & resource data   │
│  Metrics │  for 200+ services│                   │
└──────────┴──────────────────┴────────────────────┘
     ▲              ▲                  ▲
  az login     public API          az login
```

**Layer 1** — For 21+ resource types, AZ Doctor has built-in diagnostic playbooks with specific metrics, thresholds, and patterns. Fast and deterministic.

**Layer 2** — For everything else, it queries Microsoft Learn for troubleshooting docs and applies them to live data. Covers 200+ services without custom code.

**Layer 3** — For novel scenarios, universal checks (resource health, recent changes, dependency health) still provide structured diagnostic value.

## Auth

All API calls use `DefaultAzureCredential` from `@azure/identity`. Just run `az login` — the MCP server inherits your session.

**Minimum role:** Reader on the target subscription. Log Analytics queries may need Log Analytics Reader. Run `azdoctor_check_permissions` to verify.

## Standalone MCP Server

AZ Doctor works with any MCP-compatible client, not just Copilot CLI. Add to your MCP config:

```json
{
  "mcpServers": {
    "azdoctor": {
      "command": "node",
      "args": ["/path/to/azdoctor/server/build/index.js"]
    }
  }
}
```

Works with Claude Desktop, Claude Code, Cursor, VS Code, and any other MCP client. The 18 tools work independently — agents and skills are Copilot CLI-specific.

**Config file locations:**
- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- Claude Code: `.mcp.json` in your project root or global config

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `AZURE_SUBSCRIPTION_ID` | Target subscription (skips `az account show`) | Auto-detected |
| `AZDOCTOR_THRESHOLD_WARNING` | Global warning threshold % | 80 |
| `AZDOCTOR_THRESHOLD_CRITICAL` | Global critical threshold % | 90 |
| `AZDOCTOR_THRESHOLD_{TYPE}_WARNING` | Per-type warning override | — |
| `AZDOCTOR_THRESHOLD_{TYPE}_CRITICAL` | Per-type critical override | — |

Type shortcuts: `VM`, `SQL`, `APPSERVICE`, `REDIS`, `COSMOS`, `AKS`, `STORAGE`, `KEYVAULT`, `APIM`, `SERVICEBUS`, `EVENTHUB`, `POSTGRES`, `MYSQL`, `APPGW`, `LB`, `FIREWALL`, `CDN`, `COGNITIVE`, `SIGNALR`

## Local Development

```bash
cd server
npm install
npm run build
npm test
```

Test with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node build/index.js
```

## Updating

**Windows (PowerShell):**
```powershell
cd "$env:USERPROFILE\.copilot\installed-plugins\_direct\ACES-AI-Garage--azdoctor"
git pull && cd server && npm install --omit=dev
```

**macOS / Linux:**
```bash
cd ~/.copilot/installed-plugins/_direct/ACES-AI-Garage--azdoctor
git pull && cd server && npm install --omit=dev
```

Then restart Copilot CLI.

## License

MIT
