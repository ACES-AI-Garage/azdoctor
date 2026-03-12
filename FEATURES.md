# AZ Doctor — Feature Summary

## 18 MCP Tools

### Diagnostic Tools

| Tool | What It Does |
|------|-------------|
| `azdoctor_investigate` | Multi-signal investigation: correlates Resource Health, Activity Logs, Metrics, and dependent resources. Includes service-specific diagnostic patterns (11 patterns for App Service, SQL, VMs), metric trend detection via linear regression, cascading failure detection, confidence scoring, and auto-discovered Log Analytics insights. Covers 21+ resource types with built-in metric profiles. |
| `azdoctor_healthcheck` | Subscription-wide health scan with 0-100 risk scoring. Detects misconfigurations: unattached disks, orphaned public IPs, classic/ASM resources, critical resources missing locks. Flags failed deployments and high change velocity. |
| `azdoctor_baseline` | "Is this normal?" — compares current metrics against a 7-day baseline using z-scores. Flags deviations beyond 2 standard deviations as anomalous. |
| `azdoctor_sweep` | Multi-subscription health sweep. Auto-discovers all accessible subscriptions, scans them in parallel, and ranks by risk score. Portfolio-wide visibility in one command. |
| `azdoctor_query` | Natural language to KQL. 9 built-in query templates (failed requests, exceptions, slow requests, dependency failures, auth/sign-in, Azure activity, CPU/memory, security alerts, container logs). Auto-discovers Log Analytics workspaces. Falls back to full-text search for unmatched queries. |
| `azdoctor_check_permissions` | Live probes of Azure APIs (Resource Graph, Resource Health, Activity Log, Metrics, Log Analytics). Reports which APIs are accessible and recommends specific RBAC roles for any gaps. Optional `resourceId` and `workspaceId` params for deeper probing. |
| `azdoctor_advisor` | Pulls Azure Advisor recommendations via Resource Graph. Covers reliability, security, performance, cost, and operational excellence pillars. Optional `investigationContext` correlates Advisor findings with live diagnostic data for prioritized recommendations. |

### Reporting Tools

| Tool | What It Does |
|------|-------------|
| `azdoctor_rca` | Generates structured Root Cause Analysis documents with correlated timeline, root cause narrative, impact assessment, and remediation steps. Supports markdown (human-readable) and JSON (integration-ready) output formats. |
| `azdoctor_playback` | Incident timeline replay. Walks through events chronologically with phase markers (pre-incident, incident-start, during, resolution, post-incident) and human-readable context for each event. Built for post-incident reviews. |
| `azdoctor_journal` | Persists investigation results as local markdown files in `~/.azdoctor/journal/`. Save, list, and retrieve past investigations for reference. |
| `azdoctor_diagram` | Generates Mermaid diagrams: dependency topology graphs and incident timeline visualizations. Renders in GitHub PRs, VS Code preview, and documentation. Great for sharing with teams during post-incident reviews. |

### Action Tools

| Tool | What It Does |
|------|-------------|
| `azdoctor_remediate` | Executes safe remediation actions: restart (App Service, Redis), scale up (App Service Plan, SQL, Redis), scale out (App Service Plan), failover (SQL, Cosmos DB), flush cache (Redis). Dry-run mode by default — shows what would happen with risk rating and warnings before executing. Includes rollback hints. |
| `azdoctor_cost` | Cost waste analysis. Finds unattached disks, stopped-but-allocated VMs, empty App Service Plans, orphaned public IPs, idle load balancers. Right-sizes oversized VMs by analyzing CPU over 7 days. Estimates monthly savings per finding. |
| `azdoctor_alert_rules` | Generates Azure Monitor alert recommendations for 5 resource types with preconfigured thresholds. Outputs deployable Bicep templates. Can tailor thresholds from a prior investigation (tightens thresholds for recurring issues, adds early-warning alerts for rising trends). |
| `azdoctor_notify` | Sends investigation summaries to Teams (MessageCard), Slack (Block Kit), or any generic webhook. Auto-detects platform from URL, formats appropriately, and parses AZ Doctor JSON output into human-readable summaries. Useful for on-call handoffs. |

### Orchestration Tools

| Tool | What It Does |
|------|-------------|
| `azdoctor_triage` | Full diagnostic pipeline in one call: permissions check → investigation → baseline comparison → alert recommendations → journal save. Measures execution time, generates ASCII topology, and saves a comprehensive markdown report. The fastest path to a complete diagnosis. |
| `azdoctor_playbooks` | Custom diagnostic runbook management. Users create markdown playbooks with YAML frontmatter (trigger conditions, resource types, severity) in `~/.azdoctor/playbooks/`. Supports list, show, match (against investigation output), and init (creates sample playbooks) actions. |

### Utility Tools

| Tool | What It Does |
|------|-------------|
| `azdoctor_compare` | Compares two Azure scopes (resource groups or subscriptions). Diffs resource inventory, health status, and change velocity. Reports parity as matched/partial/divergent. Flags missing resource types, count mismatches, health divergence, and activity differences. |

## Resource Coverage

21+ Azure resource types with built-in metric profiles and dependency discovery:

App Service, App Service Plans, VMs, AKS, SQL Database, Cosmos DB, MySQL Flexible, PostgreSQL Flexible, Redis Cache, Storage Accounts, Application Gateway, Load Balancer, Azure Firewall, CDN, Service Bus, Event Hub, Cognitive Services, API Management, Key Vault, SignalR

## Diagnostic Intelligence

- **11 service-specific diagnostic patterns**: bad deployment, memory exhaustion, CPU saturation, health check failure, DTU exhaustion, connection storm, deadlock storm, disk bottleneck, network saturation, platform incident, rapid config changes
- **Metric trend detection**: linear regression with R-squared confidence (rising/falling/stable/volatile)
- **Cascading failure detection**: event clustering within 5-minute windows
- **Confidence scoring**: high/medium/low based on signal correlation quality
- **Change velocity detection**: sliding-window analysis of configuration change bursts
- **ASCII dependency topology**: visual resource dependency graphs in the terminal
- **Configurable thresholds**: override warning/critical percentages via environment variables (global or per-resource-type)

## Infrastructure

- **44 unit + integration tests** (vitest)
- **GitHub Actions CI** pipeline (Node 18/20/22 matrix)
- **Resource Graph caching** (60-second TTL) with pagination support (10-page safety limit)
- **Activity Log pagination** (1,000-event safety limit)
- **Rate-limited dependency checks** (batched at 5 concurrent)
- **Standalone MCP server** — works with Claude Desktop, Claude Code, Cursor, or any MCP client
- **4 Copilot CLI skills**: `/diagnose`, `/healthcheck`, `/rca`, `/compare`

## Lifecycle Coverage

```
Detect    ->  Diagnose     ->  Analyze    ->  Remediate   ->  Monitor      ->  Record       ->  Share
sweep        investigate     baseline      remediate      alert_rules     journal          notify
healthcheck  query           playback                     cost            playbooks        diagram
advisor      rca             diagram
             compare
             triage (full pipeline)
```
