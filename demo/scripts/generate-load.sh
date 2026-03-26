#!/usr/bin/env bash
set -euo pipefail

# AZ Doctor Demo — Load Generator
#
# Creates a cascading failure scenario:
#   1. Baseline — normal traffic, SQL handles it fine
#   2. Ramp up — increasing concurrent SQL queries
#   3. Database overwhelmed — DTU exhaustion causes timeouts and 500s
#   4. Recovery — traffic drops, SQL recovers
#
# On a Basic 5-DTU SQL database, phase 3 will exhaust DTU capacity,
# causing the App Service to return 500 errors with SQL timeout messages.
# This creates the dependency chain: App errors ← SQL overwhelmed.

APP_URL="${1:?Usage: generate-load.sh <APP_URL>}"

echo "=== AZ Doctor Load Generator ==="
echo "Target: $APP_URL"
echo "Scenario: SQL DTU exhaustion → cascading App Service failures"
echo ""

# Helper: send N requests to an endpoint in parallel
send_requests() {
  local url="$1"
  local count="$2"
  local concurrency="${3:-5}"

  for i in $(seq 1 "$count"); do
    curl -s -o /dev/null --max-time 30 "$url" &
    if (( i % concurrency == 0 )); then
      wait
    fi
  done
  wait
}

# --- Phase 1: Baseline (2 minutes — normal traffic) ---
echo "[Phase 1/4] Baseline — normal traffic (2 minutes)..."
echo "  Started: $(date -u +%H:%M:%S\ UTC)"
echo "  Light SQL queries, establishing normal metric baselines"

for i in $(seq 1 24); do
  send_requests "$APP_URL/health" 2 2
  send_requests "$APP_URL/api/data" 1 1
  sleep 5
done

echo "  Completed: $(date -u +%H:%M:%S\ UTC)"

# --- Phase 2: Ramp up (2 minutes — increasing SQL load) ---
echo "[Phase 2/4] Ramp up — increasing database load (2 minutes)..."
echo "  Started: $(date -u +%H:%M:%S\ UTC)"
echo "  Gradually increasing concurrent SQL queries"

for i in $(seq 1 12); do
  concurrency=$((2 + i))
  send_requests "$APP_URL/api/data" "$concurrency" "$concurrency"
  send_requests "$APP_URL/health" 1 1
  sleep 10
done

echo "  Completed: $(date -u +%H:%M:%S\ UTC)"

# --- Phase 3: Database overwhelmed (4 minutes — DTU exhaustion) ---
echo "[Phase 3/4] DATABASE OVERWHELMED — DTU exhaustion (4 minutes)..."
echo "  Started: $(date -u +%H:%M:%S\ UTC)"
echo "  Hammering SQL with concurrent heavy queries — expect timeouts and 500s"

for i in $(seq 1 24); do
  # 20 concurrent SQL queries — a 5 DTU Basic database cannot handle this
  send_requests "$APP_URL/api/data" 20 20
  # Also burn some CPU on the app service
  send_requests "$APP_URL/api/cpu?duration=3000" 2 2
  # Normal health checks continue (shows the app itself is "up" but failing)
  send_requests "$APP_URL/health" 2 2
  sleep 10
done

echo "  Completed: $(date -u +%H:%M:%S\ UTC)"

# --- Phase 4: Recovery (2 minutes — traffic drops, SQL recovers) ---
echo "[Phase 4/4] Recovery — traffic returning to normal (2 minutes)..."
echo "  Started: $(date -u +%H:%M:%S\ UTC)"

for i in $(seq 1 24); do
  send_requests "$APP_URL/health" 2 2
  send_requests "$APP_URL/api/data" 1 1
  sleep 5
done

echo "  Completed: $(date -u +%H:%M:%S\ UTC)"

echo ""
echo "=== Load generation complete ==="
echo "Total duration: ~10 minutes"
echo ""
echo "Expected results in App Insights (after 5 min):"
echo "  - Failed requests on GET /api/data with HTTP 500"
echo "  - Exception messages: SQL timeout / connection errors"
echo "  - Dependency failures: SQL calls with timeout result codes"
echo "  - SQL database: DTU near or at 100%"
echo ""
echo "Demo story: App Service 500s → caused by SQL DTU exhaustion"
