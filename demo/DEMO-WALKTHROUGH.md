# AZ Doctor Demo Walkthrough

Step-by-step script for demonstrating all 18 AZ Doctor tools using the demo environment.

## Pre-Demo Setup

### One-Time (7+ days before demo)

1. Deploy the demo infrastructure:
   ```bash
   cd demo/scripts
   bash setup.sh
   ```

2. Set up baseline traffic (creates 7-day metric baseline for the `baseline` tool):
   ```bash
   # Add to crontab — runs every 15 minutes
   crontab -e
   */15 * * * * /path/to/azdoctor/demo/scripts/baseline-cron.sh https://app-azdemo-prod-XXXXXXXX.azurewebsites.net >> /tmp/azdemo-baseline.log 2>&1
   ```

### Demo Day (30 minutes before)

1. Run the load generator to create a fresh incident:
   ```bash
   bash demo/scripts/generate-load.sh https://app-azdemo-prod-XXXXXXXX.azurewebsites.net
   ```

2. Wait 5 minutes for telemetry to appear in Application Insights.

## Demo Script

### Act 1: "What's going on?" (Detection)

**Tool 1 — check_permissions** (verify access)
```
@azure-diagnostics Check what Azure APIs my credentials can access
```
> Shows: which APIs are accessible, recommends RBAC roles for any gaps.

**Tool 2 — sweep** (portfolio overview)
```
@azure-diagnostics Scan all my subscriptions for health issues
```
> Shows: all accessible subscriptions ranked by risk score. The BAMI subscription should show elevated risk.

**Tool 3 — healthcheck** (zoom into prod)
```
@azure-diagnostics Check the health of the azdoctor-demo-prod resource group
```
> Shows: risk score, findings for unattached disk, orphaned public IP, degraded App Service, degraded SQL.

**Tool 4 — cost** (waste analysis)
```
@azure-diagnostics Find cost waste in azdoctor-demo-prod
```
> Shows: unattached disk (~$1.60/mo), orphaned IP (~$3.65/mo), stopped VM (~$7/mo), empty App Service Plan (~$13/mo), potentially oversized VM.

**Tool 5 — advisor** (Azure recommendations)
```
@azure-diagnostics Show Azure Advisor recommendations for azdoctor-demo-prod
```
> Shows: Advisor findings across reliability, security, performance, cost pillars.

---

### Act 2: "Why is it broken?" (Diagnosis)

**Tool 6 — investigate** (the star of the show)
```
@azure-diagnostics Investigate app-azdemo-prod-XXXXXXXX in resource group azdoctor-demo-prod
```
> Shows: multi-signal investigation — Http5xx spike, CPU spike, "bad_deployment" diagnostic pattern, SQL dependency degraded, cascading failure detected, metric trends, recommended actions.

**Tool 7 — baseline** (anomaly detection)
```
@azure-diagnostics Is the CPU usage on app-azdemo-prod-XXXXXXXX normal right now?
```
> Shows: current metrics vs 7-day baseline, z-scores, anomalous/elevated/normal status per metric.

**Tool 8 — query** (log analytics)
```
@azure-diagnostics Show me failed requests for app-azdemo-prod-XXXXXXXX in the last hour
```
> Shows: natural language → KQL translation, auto-discovers workspace, returns failed request details.

**Tool 9 — compare** (prod vs preprod)
```
@azure-diagnostics Compare azdoctor-demo-prod vs azdoctor-demo-preprod
```
> Shows: resource inventory diff (prod has extra waste resources), health divergence (prod degraded, preprod healthy), change velocity difference.

---

### Act 3: "What happened?" (Analysis & Reporting)

**Tool 10 — rca** (root cause analysis)
```
@azure-diagnostics Generate an RCA for app-azdemo-prod-XXXXXXXX
```
> Shows: structured RCA document with timeline, root cause narrative, impact assessment, remediation steps.

**Tool 11 — playback** (timeline replay)
```
@azure-diagnostics Replay the incident timeline for app-azdemo-prod-XXXXXXXX
```
> Shows: chronological walkthrough with phase markers (pre-incident, incident-start, during, resolution).

**Tool 12 — diagram** (visual topology)
```
@azure-diagnostics Generate a dependency diagram for app-azdemo-prod-XXXXXXXX
```
> Shows: Mermaid diagram with App Service → SQL dependency, health status on each node.

---

### Act 4: "Fix it and prevent recurrence" (Action)

**Tool 13 — remediate** (safe fix)
```
@azure-diagnostics Restart app-azdemo-prod-XXXXXXXX to mitigate the issue
```
> Shows: dry-run first (risk rating, warnings, rollback hint), then execute on confirmation.

**Tool 14 — alert_rules** (prevent recurrence)
```
@azure-diagnostics Generate alert rules for app-azdemo-prod-XXXXXXXX based on the investigation
```
> Shows: recommended alert rules with thresholds tailored from investigation data, deployable Bicep template.

---

### Act 5: "One command to rule them all" (Orchestration)

**Tool 15 — triage** (full pipeline)
```
@azure-diagnostics Run a full triage on app-azdemo-prod-XXXXXXXX
```
> Shows: permissions → investigate → baseline → alerts → journal — all in one call. ASCII topology, execution time, comprehensive report.

---

### Act 6: "Share and document" (Collaboration)

**Tool 16 — notify** (webhook notification)
```
@azure-diagnostics Send the investigation results to https://webhook.site/YOUR-UUID
```
> Shows: formatted message sent to webhook. Open webhook.site to show the formatted payload. Mention Teams and Slack support.

**Tool 17 — journal** (local persistence)
```
@azure-diagnostics List my saved investigations
```
> Shows: saved journal entries from triage run. Can retrieve any past investigation.

**Tool 18 — playbooks** (custom runbooks)
```
@azure-diagnostics Initialize sample playbooks
```
> Shows: creates sample diagnostic playbooks in ~/.azdoctor/playbooks/. Then:
```
@azure-diagnostics Match playbooks against the investigation results for app-azdemo-prod-XXXXXXXX
```
> Shows: matched playbooks based on resource type and investigation findings.

## Talking Points

- **"One question, full diagnosis"** — Instead of manually checking 5+ Azure portal blades, ask one natural language question.
- **"Correlates signals humans miss"** — Timestamp correlation across health events, activity logs, metrics, and dependencies. Finds patterns like "deployment at 2:23 PM → errors started 2:25 PM" automatically.
- **"Works with what you have"** — Reader RBAC role is enough. Uses your existing `az login`. No additional infrastructure or agents to deploy.
- **"Covers 21+ resource types out of the box"** — Built-in diagnostic playbooks for App Service, SQL, VMs, AKS, Redis, Cosmos, and more.
- **"200+ services via Microsoft Learn"** — For anything without a built-in playbook, pulls troubleshooting docs at runtime.
- **"Safe remediation"** — Dry-run by default. Shows risk rating and rollback hints before executing.
- **"Plugs into any MCP client"** — GitHub Copilot CLI, VS Code Copilot, Claude Desktop, Cursor, or any MCP-compatible tool.

## Teardown

```bash
bash demo/scripts/teardown.sh
```

Estimated cost: ~$61/month for the full demo environment. Tear down promptly after demos.
