# AZ Doctor Demo Walkthrough

> "It's Monday morning. You get a Slack message — prod is slow. Here's how you go from 'something is wrong' to 'here's the RCA and we've prevented recurrence' in under 10 minutes, without leaving your terminal."

## Before Recording

1. Run the load generator 30 minutes before:
   ```bash
   bash demo/scripts/generate-load.sh https://app-azdemo-prod-30bf1e4b.azurewebsites.net
   ```
2. Wait 5 minutes for telemetry to land in Application Insights.
3. Restart Copilot CLI so the MCP server connects fresh.
4. Verify: `/mcp show azdoctor` — should show 18 tools.

## The Demo

### Scene 1: "Something is wrong with prod" (~30s)

You just got paged. First thing — check the health of the production environment.

```
Check the health of the azdoctor-demo-prod resource group
```

**What the audience sees:** Risk score, critical findings from Resource Health (stopped VM), Azure Advisor recommendations (missing health checks, HA gaps, cost waste), and activity log anomalies — all from one command.

**Talking point:** "One command gives me Resource Health, Azure Advisor, and Activity Log findings combined — no portal clicking."

---

### Scene 2: "Why is the app broken?" (~60s)

Now zoom into the specific App Service that users are complaining about.

```
Investigate app-azdemo-prod-30bf1e4b in resource group azdoctor-demo-prod
```

**What the audience sees:** Multi-signal investigation — current health status, dependency map (App Service → SQL Database), timeline of events, diagnostic pattern detection, metric trends, Log Analytics error counts, and recommended actions.

**Talking point:** "AZ Doctor correlated Resource Health, Activity Logs, Metrics, and dependent resources automatically. It found the SQL dependency, checked its health, detected the error pattern, and told me what to do — that's 5+ portal blades in one question."

---

### Scene 3: "Is this CPU spike normal?" (~30s)

The investigation showed elevated metrics. But is this actually abnormal, or does this app always run hot?

```
Is the CPU usage on app-azdemo-prod-30bf1e4b normal right now?
```

**What the audience sees:** Current metrics compared against the 7-day baseline using z-scores. Each metric flagged as normal, elevated, or anomalous.

**Talking point:** "It compared current metrics against a 7-day rolling average. A z-score above 2 means this is statistically abnormal — not just a feeling."

---

### Scene 4: "Show me the errors" (~30s)

You know something is wrong. Now look at what's actually failing.

```
Show me failed requests for app-azdemo-prod-30bf1e4b in the last hour
```

**What the audience sees:** Natural language converted to KQL, workspace auto-discovered, query executed, results returned — failed requests by operation name with counts.

**Talking point:** "I asked in English, it wrote the KQL, found the Log Analytics workspace, and ran the query. No need to remember KQL syntax or workspace IDs."

---

### Scene 5: "Document what happened" (~30s)

You've diagnosed the issue. Now generate a formal Root Cause Analysis for the incident review.

```
Generate an RCA for app-azdemo-prod-30bf1e4b
```

**What the audience sees:** Structured RCA document with correlated timeline, root cause narrative, impact assessment, and remediation steps. Ready for ServiceNow or a post-incident review.

**Talking point:** "This is a structured RCA document I can paste into ServiceNow or share in a post-incident review — generated in seconds, not hours."

---

### Scene 6: "Is preprod affected too?" (~30s)

Before you fix prod, check if preprod has the same problem — or if this is isolated.

```
Compare azdoctor-demo-prod vs azdoctor-demo-preprod
```

**What the audience sees:** Resource inventory diff (prod has waste resources preprod doesn't), health divergence (prod degraded, preprod healthy), change velocity comparison.

**Talking point:** "Preprod is clean — this is a prod-only issue. I can also see prod has orphaned resources that preprod doesn't, which tells me someone's been provisioning without cleaning up."

---

### Scene 7: "Fix it" (~30s)

Time to remediate. Restart the App Service to clear the issue.

```
Restart app-azdemo-prod-30bf1e4b to mitigate the issue
```

**What the audience sees:** Dry-run by default — shows risk rating, what the action would do, rollback hints. Waits for confirmation before executing.

**Talking point:** "Dry-run by default. It shows me the risk rating and what will happen before I say yes. Safe remediation, not YOLO."

---

### Scene 8: "Make sure this doesn't happen again" (~30s)

The fire is out. Now set up monitoring so you catch it earlier next time.

```
Generate alert rules for app-azdemo-prod-30bf1e4b based on the investigation
```

**What the audience sees:** Recommended alert rules with thresholds tailored from the investigation data, plus a deployable Bicep template.

**Talking point:** "It generated alert rules based on what just happened — not generic defaults. And it gave me a Bicep template I can deploy directly."

---

### Scene 9: "How much are we wasting?" (~30s)

While you're here, check what's costing money for no reason.

```
Find cost waste in azdoctor-demo-prod
```

**What the audience sees:** Stopped VM still billing, empty App Service Plan, orphaned disk, orphaned public IP — each with estimated monthly cost and recommendation.

**Talking point:** "Quick pivot — this isn't just for incidents. It found a stopped VM that's still billing, an empty App Service Plan, and orphaned resources. Easy wins."

---

### Closing (~30s)

Voiceover or text slide:

> **AZ Doctor** — 18 diagnostic tools, powered by Azure Advisor + Resource Health + Activity Logs + Metrics + Log Analytics. Zero infrastructure cost. Reader RBAC. Plugs into Copilot CLI, VS Code, Claude Desktop, Cursor, or any MCP client.
>
> Think of it this way: Azure SRE Agent is the full-time SRE you hire. AZ Doctor is the doctor you visit when something hurts.

## Tips for Recording

- **Don't wait for tool responses on camera.** Record each tool call, cut out the wait, stitch together the prompt → response. Copilot's thinking animation is not interesting to watch.
- **Narrate over the output.** The JSON/table responses are dense — talk the audience through what matters.
- **Keep your terminal font size large.** 16-18pt minimum so the text is readable in the video.
- **Use a clean terminal.** Fresh Copilot CLI session, no clutter from previous commands.

## Feature Coverage

### Showcased in this demo (9 tools)

| Tool | Scene | Role in story |
|------|-------|---------------|
| `healthcheck` | 1 | First response — what's wrong? |
| `investigate` | 2 | Deep diagnosis — why is it broken? |
| `baseline` | 3 | Is this normal? |
| `query` | 4 | Show me the logs |
| `rca` | 5 | Document what happened |
| `compare` | 6 | Is preprod affected? |
| `remediate` | 7 | Fix it |
| `alert_rules` | 8 | Prevent recurrence |
| `cost` | 9 | Bonus — cost waste |

### Not in this demo (9 tools)

| Tool | Why it's excluded | How to mention it |
|------|-------------------|-------------------|
| `advisor` | Advisor findings are now embedded in healthcheck | Covered implicitly in Scene 1 |
| `triage` | Does the same as scenes 1-3 + 8 combined | "There's a one-command version that does all of this at once" |
| `sweep` | Needs multiple subscriptions to be interesting | "It can scan all your subscriptions at once" |
| `check_permissions` | Setup step, not part of the story | Skip |
| `playback` | Similar to RCA timeline | "There's also a timeline replay tool for post-incident reviews" |
| `diagram` | Mermaid output doesn't render in terminal | "Generates Mermaid diagrams for PRs and docs" |
| `journal` | Local file save, not visually interesting | "Saves investigations locally for future reference" |
| `notify` | Needs a webhook URL, adds complexity | "Can send results to Teams or Slack" |
| `playbooks` | Setup/management tool, not part of incident story | "Supports custom diagnostic runbooks" |
