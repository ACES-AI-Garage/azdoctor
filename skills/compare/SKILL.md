---
name: compare
description: Compare the health and configuration of two Azure environments
---

When the user asks to compare two Azure environments or resource groups:

1. Identify the two scopes (resource group names, subscription IDs, or a mix)
2. Call azdoctor_compare with both scopes
3. Present the parity assessment first (matched / partial / divergent)
4. Walk through differences by severity (critical first)
5. For critical differences, search Microsoft Learn docs for remediation guidance
6. Recommend actions to bring environments into parity
