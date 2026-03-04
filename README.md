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

**Proactive health checks** — "Check the health of my production subscription." Scans all resources, scores risks (0-100), and surfaces critical issues before they cause outages.

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
│  │ • Resources  │  │ • Error refs │  │ • Ticket drafts      │ │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────────┘ │
│         ▼                 ▼                    ▼               │
│    Azure APIs      learn.microsoft.com      Azure APIs         │
│    (via az login)  (public, no auth)        (via az login)     │
└────────────────────────────────────────────────────────────────┘
```

## Tools

| Tool | Purpose |
|------|---------|
| `azdoctor_healthcheck` | Subscription-wide health scan with risk scoring |
| `azdoctor_investigate` | Multi-signal investigation of a specific resource |
| `azdoctor_rca` | Structured Root Cause Analysis document generation |
| `azdoctor_check_permissions` | Detect credential access gaps and recommend role upgrades |
| `azdoctor_draft_ticket` | Pre-populate support tickets with diagnostic context |

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

You should see the `azdoctor` server listed with 5 tools. If it shows "not found", close Copilot CLI completely and reopen it.

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

You can also use the skills directly:

```
/diagnose — Investigate a specific Azure resource issue
/healthcheck — Scan your subscription for health issues and risks
/rca — Generate a structured Root Cause Analysis report
```

## Three-Layer Knowledge Strategy

AZ Doctor doesn't need hand-coded playbooks for every Azure service. It uses a layered approach:

**Layer 1 — Hard-coded playbooks** (high confidence): Deep diagnostic workflows for App Service, VMs, SQL, and networking. Deterministic, fast, no RAG needed.

**Layer 2 — RAG from Microsoft Learn** (medium confidence): For any other service, the agent queries the Learn MCP Server for troubleshooting docs at runtime and applies them to live diagnostic data. Covers 200+ Azure services without custom code.

**Layer 3 — Generic heuristics** (lower confidence): For novel scenarios, universal checks still add value — resource health, recent changes, dependency health, platform events — presented in a structured format.

As AZ Doctor matures, services graduate from Layer 2 to Layer 1 by adding dedicated playbooks.

## Auth

All Azure API calls use `DefaultAzureCredential` from `@azure/identity`. Run `az login` before starting Copilot CLI — the MCP server inherits your CLI session automatically. No additional auth setup needed.

**Minimum role:** Reader on the target subscription covers Resource Health, Activity Logs, Resource Graph, and Metrics. Log Analytics may require Log Analytics Reader. Support ticket creation requires Support Request Contributor and a paid support plan.

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

All 5 tools should appear and respond in the inspector.

## License

MIT
