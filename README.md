# AZ Doctor

**AI-powered Azure diagnostics for GitHub Copilot CLI.**

Multi-signal correlation, root cause analysis, and proactive risk scoring — delivered as a Copilot CLI plugin backed by an MCP server.

## The Idea

Azure MCP Server gives you the **stethoscope** — raw signals from health APIs, activity logs, and metrics.

Microsoft Learn MCP Server gives you the **medical textbook** — troubleshooting guides, error references, and diagnostic documentation for 200+ Azure services.

AZ Doctor gives you the **doctor** — diagnostic reasoning that correlates signals across sources, identifies root causes, and produces structured output engineers actually need.

No single existing tool combines all three. AZ Doctor is the orchestration layer that ties them together.

## What It Does

**Reactive investigation** — "Why is my app slow?" One prompt triggers a full diagnostic workflow: resource health, activity logs, metrics, dependent resources, and timestamp correlation across all signals. What used to take 5+ manual queries and mental correlation now takes one question.

**Root cause analysis** — "Generate an RCA for this incident." Produces a structured markdown document with correlated timeline, root cause narrative, impact assessment, and remediation steps. Ready for ServiceNow, post-incident reviews, or management.

**Proactive health checks** — "Check the health of my production subscription." Scans all resources, scores risks (0-100), detects misconfigurations (unattached disks, orphaned public IPs, classic resources), and surfaces critical issues before they cause outages.

**Environment comparison** — "Compare prod vs staging." Diffs resource inventory, health status, and change velocity between two scopes. Flags parity issues before deployments.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  GitHub Copilot CLI                                            │
│  (UI, conversational loop, model, tool execution)              │
├────────────────────────────────────────────────────────────────┤
│  AZ Doctor Plugin                                              │
│  ├─ plugin.json        Plugin manifest                         │
│  ├─ agents/            Diagnostic agent instructions           │
│  ├─ skills/            Workflow templates                      │
│  └─ mcp-config.json    Wires up the MCP server                │
├────────────────────────────────────────────────────────────────┤
│                    MCP SERVER LAYER                             │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ Azure MCP    │  │ Learn MCP    │  │ AZ Doctor MCP Server │ │
│  │ Server       │  │ Server       │  │ (this repo)          │ │
│  │              │  │              │  │                      │ │
│  │ Live data:   │  │ Knowledge:   │  │ Orchestration:       │ │
│  │ • Health     │  │ • TSGs       │  │ • Correlation        │ │
│  │ • Logs       │  │ • Docs       │  │ • RCA generation     │ │
│  │ • Metrics    │  │ • How-tos    │  │ • Risk scoring       │ │
│  │ • Resources  │  │ • Error refs │  │ • Perm checks        │ │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────────┘ │
│         ▼                 ▼                    ▼               │
│    Azure APIs      learn.microsoft.com      Azure APIs         │
│    (via az login)  (public, no auth)        (via az login)     │
└────────────────────────────────────────────────────────────────┘
```

## Tools

| Tool | Purpose |
|------|---------|
| `azdoctor_healthcheck` | Subscription-wide health scan with risk scoring and misconfiguration detection |
| `azdoctor_investigate` | Multi-signal investigation with dependency discovery, diagnostic patterns, trend detection, and confidence scoring |
| `azdoctor_rca` | Structured Root Cause Analysis document generation (markdown or JSON) |
| `azdoctor_check_permissions` | Live probe of Azure API access with RBAC role recommendations |
| `azdoctor_compare` | Compare health and resources between two Azure scopes (e.g., prod vs staging) |
| `azdoctor_remediate` | Execute safe remediation actions (restart, scale, failover) with dry-run mode and risk ratings |
| `azdoctor_query` | Natural language to KQL — auto-discovers workspaces and runs queries |
| `azdoctor_cost` | Cost waste analysis — finds idle resources, oversized VMs, orphaned storage |
| `azdoctor_playback` | Incident timeline replay with phase markers and contextual explanations |
| `azdoctor_alert_rules` | Generate Azure Monitor alert recommendations with deployable Bicep templates |
| `azdoctor_sweep` | Multi-subscription health sweep — ranks all subscriptions by risk score |
| `azdoctor_baseline` | Compare current metrics against 7-day baseline to detect anomalies |
| `azdoctor_journal` | Save, list, and retrieve investigation results as local markdown files |
| `azdoctor_triage` | Full diagnostic pipeline in one call — permissions, investigation, baseline, alerts, and journal save |
| `azdoctor_diagram` | Generate Mermaid dependency topology and incident timeline diagrams |
| `azdoctor_advisor` | Pull Azure Advisor recommendations with optional investigation correlation |
| `azdoctor_notify` | Send investigation summaries to Teams, Slack, or any webhook |
| `azdoctor_playbooks` | Manage custom diagnostic runbooks with trigger-based matching |

All tools auto-detect your Azure subscription from `az CLI` — no need to pass a subscription ID.

## Install

### Prerequisites

- [GitHub Copilot CLI](https://docs.github.com/en/copilot) installed and working (`copilot` command in your terminal)
- Azure CLI installed and logged in (`az login`)
- Node.js 18+

### Step 1: Install the plugin

In Copilot CLI, run:

```
/plugin install ACES-AI-Garage/azdoctor
```

### Step 2: Install server dependencies

The MCP server needs its npm dependencies. Run this once after installing the plugin:

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

### Step 3: Restart and verify

Restart Copilot CLI, then run:

```
/mcp show azdoctor
```

You should see the `azdoctor` server listed with 18 tools. If it shows "not found", close Copilot CLI completely and reopen it.

### Updating

To pull the latest version:

**Windows (PowerShell):**
```powershell
cd "$env:USERPROFILE\.copilot\installed-plugins\_direct\ACES-AI-Garage--azdoctor"
git pull
cd server
npm install --omit=dev
```

**macOS / Linux:**
```bash
cd ~/.copilot/installed-plugins/_direct/ACES-AI-Garage--azdoctor
git pull
cd server
npm install --omit=dev
```

Then restart Copilot CLI.

## Usage

Once installed, use the `@azure-diagnostics` agent in Copilot CLI:

```
@azure-diagnostics Check the health of my subscription
```

```
@azure-diagnostics Why is my app service prod-api returning 500 errors?
```

```
@azure-diagnostics Investigate sqlserver-nexus-corbin in resource group Nexus-Corbin
```

```
@azure-diagnostics Generate an RCA for the outage on prod-api between 2pm and 4pm UTC today
```

```
@azure-diagnostics Compare the health of resource group prod-rg vs staging-rg
```

```
@azure-diagnostics Check what Azure APIs my credentials can access
```

```
@azure-diagnostics Is my prod-api CPU usage normal right now?
```

```
@azure-diagnostics Show me failed requests for prod-api in the last hour
```

```
@azure-diagnostics Find cost waste in my subscription
```

```
@azure-diagnostics Replay what happened to prod-api between 2pm and 4pm UTC
```

```
@azure-diagnostics Restart prod-api to mitigate the issue
```

```
@azure-diagnostics Generate alert rules for prod-api based on the investigation
```

```
@azure-diagnostics Scan all my subscriptions for health issues
```

```
@azure-diagnostics Run a full triage on prod-api
```

```
@azure-diagnostics Generate a dependency diagram for prod-api
```

```
@azure-diagnostics Send the investigation results to our Teams channel
```

```
@azure-diagnostics Show Azure Advisor recommendations for my subscription
```

You can also use the skills directly:

```
/diagnose — Investigate a specific Azure resource issue
/healthcheck — Scan your subscription for health issues and risks
/rca — Generate a structured Root Cause Analysis report
/compare — Compare two Azure environments
```

## Three-Layer Knowledge Strategy

AZ Doctor doesn't need hand-coded playbooks for every Azure service. It uses a layered approach:

**Layer 1 — Hard-coded playbooks** (high confidence): Deep diagnostic workflows with built-in metric profiles for 21+ resource types (App Service, VMs, AKS, SQL, Cosmos DB, Redis, Storage, App Gateway, Load Balancer, Firewall, CDN, Service Bus, Event Hub, Key Vault, API Management, Cognitive Services, SignalR, MySQL, PostgreSQL). Deterministic, fast, no RAG needed.

**Layer 2 — RAG from Microsoft Learn** (medium confidence): For any other service, the agent queries the Learn MCP Server for troubleshooting docs at runtime and applies them to live diagnostic data. Covers 200+ Azure services without custom code.

**Layer 3 — Generic heuristics** (lower confidence): For novel scenarios, universal checks still add value — resource health, recent changes, dependency health, platform events — presented in a structured format.

As AZ Doctor matures, services graduate from Layer 2 to Layer 1 by adding dedicated playbooks.

## Auth

All Azure API calls use `DefaultAzureCredential` from `@azure/identity`. Run `az login` before starting Copilot CLI — the MCP server inherits your CLI session automatically. No additional auth setup needed.

**Minimum role:** Reader on the target subscription covers Resource Health, Activity Logs, Resource Graph, and Metrics. Log Analytics may require Log Analytics Reader. Use `azdoctor_check_permissions` to verify your access before investigating.

## Local Development

```bash
cd server
npm install
npm run build
```

Test with MCP Inspector:

```bash
cd server
npx @modelcontextprotocol/inspector node build/index.js
```

All 13 tools should appear and respond in the inspector.

## Standalone MCP Server

AZ Doctor works as a standalone MCP server with any MCP-compatible client (Claude Desktop, Cursor, VS Code, etc.), not just GitHub Copilot CLI.

### Claude Desktop

Add to your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

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

### Claude Code

Add to your project's `.mcp.json` or global MCP config:

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

### Any MCP Client

AZ Doctor uses STDIO transport. Point any MCP-compatible client at `node server/build/index.js`. The server exposes 18 tools that work independently of the Copilot CLI plugin layer (agents and skills are Copilot-specific).

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `AZURE_SUBSCRIPTION_ID` | Target subscription (skips `az account show`) | Auto-detected |
| `AZDOCTOR_THRESHOLD_WARNING` | Global warning threshold % | 80 |
| `AZDOCTOR_THRESHOLD_CRITICAL` | Global critical threshold % | 90 |
| `AZDOCTOR_THRESHOLD_{TYPE}_WARNING` | Per-type warning override | — |
| `AZDOCTOR_THRESHOLD_{TYPE}_CRITICAL` | Per-type critical override | — |

Type shortcuts: `VM`, `SQL`, `APPSERVICE`, `REDIS`, `COSMOS`, `AKS`, `STORAGE`, `KEYVAULT`, `APIM`, `SERVICEBUS`, `EVENTHUB`, `POSTGRES`, `MYSQL`, `APPGW`, `LB`, `FIREWALL`, `CDN`, `COGNITIVE`, `SIGNALR`

## License

MIT
