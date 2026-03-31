---
name: rbac
description: Diagnose Azure RBAC permission and role assignment issues
---

When the user reports RBAC issues (access denied, can't assign role, permission errors):

1. Call azdoctor_rbac_audit with subscription and any known principal/resource
2. If user mentions a specific failed operation, search Microsoft Learn for the required permissions
3. If limits are approaching, guide through consolidation (group-based assignments, remove redundant)
4. If orphaned assignments found, recommend cleanup
5. Present: Symptom → Root Cause → Remediation Steps → Prevention

For portal UI issues (button disabled, roles not listed, features grayed out),
refer users to: https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting?tabs=bicep

For propagation/caching issues (changes not taking effect), advise:
- Wait 10 minutes for role assignment propagation
- Sign out and sign back in to refresh cached tokens
- For managed identity group membership changes, allow up to 24 hours

For data action issues at management group scope:
- Custom roles with data actions cannot be assigned at management group scope
- Refer to: https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting?tabs=bicep
