#!/usr/bin/env bash
set -euo pipefail

# AZ Doctor Demo — Baseline Traffic Generator
# Run this every 15 minutes for 7+ days before the demo to build baseline metrics.
#
# Setup with cron:
#   crontab -e
#   */15 * * * * /path/to/azdoctor/demo/scripts/baseline-cron.sh https://app-azdemo-prod-XXXXXXXX.azurewebsites.net >> /tmp/azdemo-baseline.log 2>&1

APP_URL="${1:?Usage: baseline-cron.sh <APP_URL>}"

for i in $(seq 1 10); do
  curl -s -o /dev/null --max-time 10 "$APP_URL/health"
  curl -s -o /dev/null --max-time 10 "$APP_URL/api/data"
  sleep 2
done

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Baseline traffic sent to $APP_URL"
