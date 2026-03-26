# AZ Doctor

**AI-powered Azure diagnostics for any MCP client.**

Azure MCP Server gives you the stethoscope — raw signals from health APIs, activity logs, and metrics. AZ Doctor gives you the doctor — it knows what telemetry to pull for any Azure resource type, compiles diagnostic data from multiple sources in a single call, and gives the AI model everything it needs to reason about root causes. When paired with the Microsoft Learn MCP Server, the AI can also pull troubleshooting docs to enrich its diagnosis.

## What It Does

AZ Doctor dynamically discovers what telemetry each Azure resource emits, resolves where metrics actually live (e.g., CPU and memory are on the App Service Plan, not the site), parses resource configuration to find actual dependencies, auto-discovers Log Analytics workspaces, and compiles failed requests, exceptions, and dependency failures — all in a single tool call.

No hardcoded playbooks. No resource-specific configuration. It works for App Services, VMs, SQL Databases, Redis, Cosmos DB, AKS, and any other resource type that emits Azure Monitor metrics.

## Quick Start

### Prerequisites

- [GitHub Copilot CLI](https://docs.github.com/en/copilot) installed (or any MCP client)
- Azure CLI logged in (`az login`)
- Node.js 18+

### Install

**Step 1:** Install the plugin in Copilot CLI:

```
/plugin install ACES-AI-Garage/azdoctor
```

**Step 2:** Install the MCP server dependencies:

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

**Step 3:** Register the MCP server. Due to a [Copilot CLI bug](https://github.com/github/copilot-cli/issues/693), plugin MCP servers don't auto-register. Add manually:

**Windows** — create/edit `%USERPROFILE%\.copilot\mcp-config.json`:
```json
{
  "mcpServers": {
    "azdoctor": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Users/YOUR_USERNAME/.copilot/installed-plugins/_direct/ACES-AI-Garage--azdoctor/server/build/index.js"]
    }
  }
}
```

**macOS / Linux** — create/edit `~/.copilot/mcp-config.json`:
```json
{
  "mcpServers": {
    "azdoctor": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/.copilot/installed-plugins/_direct/ACES-AI-Garage--azdoctor/server/build/index.js"]
    }
  }
}
```

> Replace `YOUR_USERNAME` with your actual username. If you already have an `mcp-config.json` with other servers, add the `azdoctor` entry inside the existing `mcpServers` object — don't replace the whole file.

**Step 4:** Restart Copilot CLI and verify:

```
/mcp show azdoctor
```

You should see 6 tools.

## Usage

Ask in natural language — the MCP tools are picked up automatically.

```
Check the health of my production resource group
Investigate my-app-service in resource group prod-rg
Is the CPU usage on my-app-service normal right now?
Compare prod-rg vs staging-rg
Restart my-app-service to mitigate the issue
Generate alert rules for my-app-service based on the investigation
```

For incident RCAs, scope the investigation to a time window:

```
Investigate my-app-service with start time 2026-03-25T14:00:00Z and end time 2026-03-25T16:00:00Z
```

## Tools

| Tool | What it does |
|------|-------------|
| `azdoctor_investigate` | Multi-signal diagnostic data gathering for any resource type. Dynamically discovers metrics, resolves parent resources, finds dependencies from configuration, queries Log Analytics for errors and exceptions. Supports incident time windows for RCA scoping. |
| `azdoctor_healthcheck` | Subscription or resource group scan combining Resource Health, Azure Advisor cost findings, and Activity Log anomalies into a risk-scored assessment. |
| `azdoctor_baseline` | Compares current metrics against a 7-day rolling average using z-scores. Answers "is this normal?" with statistical confidence. |
| `azdoctor_compare` | Diffs two environments across resource inventory, health status, and change velocity. Surfaces parity issues and infrastructure drift. |
| `azdoctor_remediate` | Safe operational actions (restart, scale, failover) with dry-run mode by default. Shows risk ratings and expected impact before execution. |
| `azdoctor_alert_rules` | Generates Azure Monitor alert rules using dynamically discovered metrics, with thresholds tailored from investigation data. Outputs deployable Bicep templates. |

All tools auto-detect your subscription from `az CLI`.

## How It Works

```
You (natural language)
 │
 ▼
┌──────────────────────────────────────────────────┐
│              AZ Doctor MCP Server                 │
│                                                   │
│  Discovers available metrics dynamically          │
│  Resolves parent resources (App → Plan)           │
│  Parses config for actual dependencies            │
│  Auto-discovers Log Analytics workspaces          │
│  Compiles diagnostic data for AI reasoning        │
├──────────┬──────────────────┬────────────────────┤
│  Azure   │  Azure Monitor   │  Azure Advisor /   │
│  APIs    │  Metrics API     │  Resource Graph    │
│          │                  │                    │
│  Health  │  Metric defs +   │  Recommendations   │
│  Logs    │  metric values   │  & resource data   │
│  Events  │  for ANY type    │                    │
└──────────┴──────────────────┴────────────────────┘
     ▲              ▲                  ▲
  az login       az login           az login
```

AZ Doctor doesn't maintain hardcoded metric lists per resource type. It calls Azure Monitor's metric definitions API at runtime to discover what telemetry each resource emits, then pulls the most diagnostically relevant signals. This means it works for any Azure resource type without service-specific code.

## Auth

All API calls use `DefaultAzureCredential` from `@azure/identity`. Just run `az login` — the MCP server inherits your session.

**Minimum role:** Reader on the target subscription. Log Analytics queries may need Log Analytics Reader.

## Other MCP Clients

AZ Doctor works with any MCP-compatible client, not just Copilot CLI.

### GitHub Copilot (VS Code)

Add to your workspace `.vscode/mcp.json`:

```json
{
  "servers": {
    "azdoctor": {
      "command": "node",
      "args": ["/path/to/azdoctor/server/build/index.js"]
    }
  }
}
```

### Claude Desktop / Claude Code / Cursor

Add to your MCP config:

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
