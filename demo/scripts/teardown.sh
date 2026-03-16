#!/usr/bin/env bash
set -euo pipefail

# AZ Doctor Demo — Teardown
# Deletes both resource groups and all resources within them.

echo "=== AZ Doctor Demo Teardown ==="
echo ""
echo "This will DELETE the following resource groups and ALL resources in them:"
echo "  - azdoctor-demo-prod"
echo "  - azdoctor-demo-preprod"
echo ""
read -p "Are you sure? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo "Deleting azdoctor-demo-prod..."
az group delete --name azdoctor-demo-prod --yes --no-wait

echo "Deleting azdoctor-demo-preprod..."
az group delete --name azdoctor-demo-preprod --yes --no-wait

echo ""
echo "Deletion initiated (runs in background). Resources will be removed in 5-10 minutes."
echo "Verify with: az group list --query \"[?starts_with(name,'azdoctor-demo')].name\" -o tsv"
