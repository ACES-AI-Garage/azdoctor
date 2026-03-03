---
name: healthcheck
description: Scan Azure resources for health issues and proactive risks
---

When the user asks to check the health of their Azure environment:

1. Ask for subscription ID if not provided (check environment variable AZURE_SUBSCRIPTION_ID)
2. Optionally scope to a resource group
3. Call azdoctor_healthcheck
4. Present critical findings first with immediate recommended actions
5. For critical items, search Microsoft Learn docs for remediation steps
6. Summarize warnings and provide the overall risk score
