---
name: diagnose
description: Diagnose an Azure resource issue by correlating health, logs, and metrics
---

When the user asks to diagnose an Azure resource issue:

1. Identify the resource (name, type, resource group, subscription)
2. Call azdoctor_investigate with the resource details and timeframe
3. Search Microsoft Learn docs for troubleshooting guidance relevant to the service type and symptom
4. Correlate the live signals with the documented troubleshooting steps
5. Present findings as: Current Status → Recent Changes → Likely Cause → Recommended Actions
6. Ask if the user wants a full RCA report or to escalate to support
