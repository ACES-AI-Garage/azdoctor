#!/usr/bin/env bash
set -euo pipefail

# AZ Doctor Demo — Setup Script
# Deploys infrastructure, app, and seeds initial data

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEMO_DIR="$(dirname "$SCRIPT_DIR")"
LOCATION="${LOCATION:-eastus2}"

echo "=== AZ Doctor Demo Setup ==="
echo ""

# 1. Validate prerequisites
echo "[1/8] Validating prerequisites..."
command -v az >/dev/null 2>&1 || { echo "ERROR: Azure CLI not found. Install from https://aka.ms/installazurecli"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js not found."; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "ERROR: zip not found."; exit 1; }

SUB_ID=$(az account show --query id -o tsv 2>/dev/null) || { echo "ERROR: Not logged in. Run 'az login' first."; exit 1; }
SUB_NAME=$(az account show --query name -o tsv)
echo "  Subscription: $SUB_NAME ($SUB_ID)"

# 2. Generate unique suffix and SQL password
echo "[2/8] Generating deployment parameters..."
SUFFIX=$(echo "$SUB_ID" | cut -c1-8)
SQL_PASS="AzD0ctor-$(openssl rand -hex 8)!"
echo "  Suffix: $SUFFIX"

# 3. Deploy Bicep template
echo "[3/8] Deploying infrastructure (this takes 3-5 minutes)..."
DEPLOY_OUTPUT=$(az deployment sub create \
  --location "$LOCATION" \
  --template-file "$DEMO_DIR/infra/main.bicep" \
  --parameters sqlAdminPassword="$SQL_PASS" uniqueSuffix="$SUFFIX" location="$LOCATION" \
  --query "properties.outputs" -o json)

PROD_APP_NAME=$(echo "$DEPLOY_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['prodAppName']['value'])" 2>/dev/null || echo "app-azdemo-prod-$SUFFIX")
PREPROD_APP_NAME=$(echo "$DEPLOY_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['preprodAppName']['value'])" 2>/dev/null || echo "app-azdemo-preprod-$SUFFIX")
PROD_APP_URL=$(echo "$DEPLOY_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['prodAppUrl']['value'])" 2>/dev/null || echo "https://$PROD_APP_NAME.azurewebsites.net")
PREPROD_APP_URL=$(echo "$DEPLOY_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['preprodAppUrl']['value'])" 2>/dev/null || echo "https://$PREPROD_APP_NAME.azurewebsites.net")

echo "  Prod app: $PROD_APP_NAME"
echo "  Preprod app: $PREPROD_APP_NAME"

# 4. Package and deploy the sample app
echo "[4/8] Deploying sample app to both environments..."
cd "$DEMO_DIR/app"
zip -r -q /tmp/azdemo-app.zip . -x "node_modules/*"

echo "  Deploying to prod..."
az webapp deploy --resource-group azdoctor-demo-prod --name "$PROD_APP_NAME" \
  --src-path /tmp/azdemo-app.zip --type zip --async true 2>/dev/null || \
az webapp deployment source config-zip --resource-group azdoctor-demo-prod --name "$PROD_APP_NAME" \
  --src /tmp/azdemo-app.zip

echo "  Deploying to preprod..."
az webapp deploy --resource-group azdoctor-demo-preprod --name "$PREPROD_APP_NAME" \
  --src-path /tmp/azdemo-app.zip --type zip --async true 2>/dev/null || \
az webapp deployment source config-zip --resource-group azdoctor-demo-preprod --name "$PREPROD_APP_NAME" \
  --src /tmp/azdemo-app.zip

rm /tmp/azdemo-app.zip
cd "$SCRIPT_DIR"

# 5. Stop the waste VM (without deallocating — keeps billing, cost tool detects this)
echo "[5/8] Stopping waste VM (without deallocating)..."
VM_NAME="vm-waste-prod-$SUFFIX"
az vm stop --resource-group azdoctor-demo-prod --name "$VM_NAME" --no-wait || echo "  WARNING: VM stop failed (may still be provisioning)"

# 6. Create activity log entries for playback tool
echo "[6/8] Seeding activity log entries..."
az webapp config appsettings set --resource-group azdoctor-demo-prod --name "$PROD_APP_NAME" \
  --settings DEPLOY_VERSION=1.0.0 -o none
sleep 5
az webapp config appsettings set --resource-group azdoctor-demo-prod --name "$PROD_APP_NAME" \
  --settings DEPLOY_VERSION=1.1.0-bad -o none
sleep 3
az webapp restart --resource-group azdoctor-demo-prod --name "$PROD_APP_NAME" -o none
sleep 5
az webapp config appsettings set --resource-group azdoctor-demo-prod --name "$PROD_APP_NAME" \
  --settings DEPLOY_VERSION=1.1.1-hotfix -o none

# 7. Wait for apps to start, then verify
echo "[7/8] Waiting for apps to start (60 seconds)..."
sleep 60

echo "  Testing prod app..."
PROD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$PROD_APP_URL/health" || echo "000")
echo "  Prod /health: HTTP $PROD_STATUS"

echo "  Testing preprod app..."
PREPROD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$PREPROD_APP_URL/health" || echo "000")
echo "  Preprod /health: HTTP $PREPROD_STATUS"

# 8. Run load generator
echo "[8/8] Running load generator to create incident data..."
bash "$SCRIPT_DIR/generate-load.sh" "$PROD_APP_URL"

# Summary
echo ""
echo "============================================"
echo "  AZ Doctor Demo Environment Ready"
echo "============================================"
echo ""
echo "  Prod App:       $PROD_APP_URL"
echo "  Preprod App:    $PREPROD_APP_URL"
echo "  Prod RG:        azdoctor-demo-prod"
echo "  Preprod RG:     azdoctor-demo-preprod"
echo "  SQL Login:      sqladmin"
echo "  SQL Password:   $SQL_PASS"
echo "  Waste VM:       $VM_NAME (stopped, not deallocated)"
echo "  Suffix:         $SUFFIX"
echo ""
echo "  Wait ~5 minutes for App Insights telemetry to appear."
echo "  For the baseline tool, run baseline-cron.sh every 15 min for 7+ days."
echo ""
echo "  To tear down: bash $SCRIPT_DIR/teardown.sh"
echo "============================================"
