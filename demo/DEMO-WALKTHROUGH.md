# AZ Doctor Demo Walkthrough

> "It's Monday morning. You get a Slack message — prod is slow, users are seeing 500 errors. Here's how you go from 'something is wrong' to 'here's the RCA, the fix, and the alerts to prevent recurrence' — without leaving your terminal."

## Before Recording

1. Run the load generator 30 minutes before:
   ```bash
   bash demo/scripts/generate-load.sh https://app-azdemo-prod-30bf1e4b.azurewebsites.net
   ```
2. Wait 5 minutes for telemetry to land in Application Insights.
3. Restart Copilot CLI so the MCP server connects fresh.
4. Verify: `/mcp show azdoctor` — should show 6 tools.

## The Demo

### Scene 1: "Something is wrong with prod" (~45s)

You just got paged. Start with a health scan to see the big picture.

```
Check the health of the azdoctor-demo-prod resource group
```

**What the audience sees:** Risk score, Resource Health status for all resources, Advisor cost findings (orphaned disk, empty plan), any failed deployments.

**Talking point:** "One command — Resource Health, Azure Advisor, and Activity Logs combined. I can see there's cost waste and a stopped VM, but what about the app?"

---

### Scene 2: "Deep dive into the app" (~90s)

This is the money shot. Investigate the App Service in depth.

```
Investigate app-azdemo-prod-30bf1e4b in resource group azdoctor-demo-prod
```

**What the audience sees:**
- **Metrics from the right places** — CPU and memory from the App Service Plan (where they actually live), HTTP errors and response times from the site itself. AZ Doctor figured this out dynamically — no hardcoded config.
- **Real error details** — actual failing endpoints with HTTP status codes, average latency, exception messages from Log Analytics
- **Dependency failures** — SQL call failures, external HTTP timeouts
- **Actual dependencies** — found by parsing the app's connection strings, not just grabbing everything in the resource group
- **Recent changes** — deployments, config changes, restarts from the activity log

**Talking point:** "AZ Doctor dynamically discovered what metrics this resource emits, resolved that CPU and memory live on the App Service Plan, parsed the app's connection strings to find the SQL dependency, auto-discovered the Log Analytics workspace, and pulled failed requests, exceptions, and dependency failures — all in one call. Try doing that by hand."

**Follow-up (shows depth):**
```
Now investigate the SQL database sqldb-azdemo-prod in the same resource group
```

**What the audience sees:** The same tool, same quality of output, but for a completely different resource type — SQL metrics (DTU, CPU, connections, deadlocks), no hardcoded logic. AZ Doctor dynamically discovered the SQL database's available metrics.

**Talking point:** "Same tool, different resource type. AZ Doctor doesn't have hardcoded playbooks — it asks Azure what metrics are available and pulls them. This works for VMs, Redis, Cosmos, AKS, anything."

---

### Scene 3: "Is this CPU spike normal?" (~30s)

The investigation showed elevated metrics. But is this abnormal?

```
Is the CPU usage on app-azdemo-prod-30bf1e4b normal right now?
```

**What the audience sees:** Current metrics compared against 7-day baseline using z-scores. Each metric flagged as normal, elevated, or anomalous. CPU and memory from the plan, HTTP metrics from the site.

**Talking point:** "Z-score comparison against a 7-day rolling average. This isn't a guess — it's statistically abnormal."

---

### Scene 4: "Generate the RCA" (~30s)

You've diagnosed the issue. Now generate a formal Root Cause Analysis scoped to the incident window.

```
Investigate app-azdemo-prod-30bf1e4b with start time 21:00 UTC today and end time 22:00 UTC today
```

**What the audience sees:** Same rich investigation data, but scoped to the incident window. The model uses this to write a structured RCA.

**Follow-up:**
```
Write a formal RCA document based on that investigation
```

**What the audience sees:** The model writes a structured RCA — timeline, root cause, impact, remediation steps — from the raw diagnostic data. Ready for ServiceNow or a post-incident review.

**Talking point:** "AZ Doctor gathered the data. The AI wrote the RCA. I didn't have to open a single portal blade."

---

### Scene 5: "Is preprod affected?" (~30s)

Before you fix prod, check if preprod has the same issue.

```
Compare azdoctor-demo-prod vs azdoctor-demo-preprod
```

**What the audience sees:** Resource inventory diff, health divergence (prod degraded, preprod clean), resource count differences.

**Talking point:** "Preprod is clean — this is prod-only. I can also see infrastructure drift — prod has resources that don't exist in preprod."

---

### Scene 6: "Fix it" (~30s)

Restart the app to clear the issue.

```
Restart app-azdemo-prod-30bf1e4b
```

**What the audience sees:** Dry-run first — risk rating, expected downtime, rollback hints. Waits for confirmation.

**Talking point:** "Dry-run by default. It shows me the risk before I commit. Safe remediation."

---

### Scene 7: "Prevent recurrence" (~30s)

Set up alerts so you catch this earlier next time.

```
Generate alert rules for app-azdemo-prod-30bf1e4b based on what we found
```

**What the audience sees:** Alert rules with thresholds tailored from the investigation data, plus a deployable Bicep template. Metrics discovered dynamically, not hardcoded.

**Talking point:** "Alert rules based on what actually happened — not generic defaults. And a Bicep template I can deploy right now."

---

### Closing (~30s)

> **AZ Doctor** — 6 focused diagnostic tools that do the hard part: dynamically discover metrics for any Azure resource type, resolve dependencies from actual configuration, auto-discover Log Analytics workspaces, and compile everything into raw diagnostic data the AI can reason over.
>
> Zero infrastructure cost. Reader RBAC. Works with Copilot CLI, VS Code, Claude Desktop, Cursor, or any MCP client.
>
> Azure SRE Agent is the full-time SRE you hire. AZ Doctor is the doctor you visit when something hurts.

## Tips for Recording

- **Don't wait for tool responses on camera.** Record each tool call, cut out the wait, stitch the prompt → response.
- **Scene 2 is the star.** Spend the most time here. Show the metrics, the error details, the dependency resolution. Then show it works for SQL too.
- **Narrate over the output.** The JSON/tables are dense — talk the audience through what matters.
- **Keep your terminal font size large.** 16-18pt minimum.
- **Use a clean terminal.** Fresh Copilot CLI session.

## Feature Coverage

### Showcased (6 tools)

| Tool | Scene | Role |
|------|-------|------|
| `healthcheck` | 1 | Big picture — what's wrong? |
| `investigate` | 2, 4 | Deep diagnosis + RCA data gathering |
| `baseline` | 3 | Is this normal? |
| `compare` | 5 | Is preprod affected? |
| `remediate` | 6 | Fix it safely |
| `alert_rules` | 7 | Prevent recurrence |

### Key differentiator to highlight

AZ Doctor's value isn't in the number of tools — it's that `investigate` dynamically discovers what telemetry is available for ANY Azure resource type and compiles it all in one call. No hardcoded playbooks, no resource-specific configuration. The AI does the reasoning.

## Teardown

```bash
bash demo/scripts/teardown.sh
```
