#!/usr/bin/env bash
set -euo pipefail

# AZ Doctor Demo — Load Generator
# Creates a synthetic incident pattern with 4 phases:
#   1. Baseline (normal traffic)
#   2. Slow degradation
#   3. Error spike (the incident)
#   4. Recovery

APP_URL="${1:?Usage: generate-load.sh <APP_URL>}"

echo "=== AZ Doctor Load Generator ==="
echo "Target: $APP_URL"
echo ""

# Helper: send N requests to an endpoint in parallel
send_requests() {
  local url="$1"
  local count="$2"
  local concurrency="${3:-5}"

  for i in $(seq 1 "$count"); do
    curl -s -o /dev/null --max-time 15 "$url" &
    # Limit concurrency
    if (( i % concurrency == 0 )); then
      wait
    fi
  done
  wait
}

# --- Phase 1: Baseline (2 minutes of normal traffic) ---
echo "[Phase 1/4] Baseline — normal traffic (2 minutes)..."
echo "  Started: $(date -u +%H:%M:%S\ UTC)"

for i in $(seq 1 24); do
  send_requests "$APP_URL/health" 2 2
  send_requests "$APP_URL/api/data" 1 1
  sleep 5
done

echo "  Completed: $(date -u +%H:%M:%S\ UTC)"

# --- Phase 2: Slow degradation (2 minutes) ---
echo "[Phase 2/4] Slow degradation (2 minutes)..."
echo "  Started: $(date -u +%H:%M:%S\ UTC)"

for i in $(seq 1 12); do
  send_requests "$APP_URL/api/data" 3 3
  send_requests "$APP_URL/api/slow?delay=2000" 2 2
  sleep 10
done

echo "  Completed: $(date -u +%H:%M:%S\ UTC)"

# --- Phase 3: Error spike — the incident (3 minutes) ---
echo "[Phase 3/4] ERROR SPIKE — incident in progress (3 minutes)..."
echo "  Started: $(date -u +%H:%M:%S\ UTC)"

for i in $(seq 1 18); do
  # Hammer errors
  send_requests "$APP_URL/api/error" 10 10
  # Hammer SQL to exhaust DTUs
  send_requests "$APP_URL/api/data" 15 15
  # Burn CPU
  send_requests "$APP_URL/api/cpu?duration=5000" 2 2
  # Some slow requests
  send_requests "$APP_URL/api/slow?delay=5000" 3 3
  # Flapping
  send_requests "$APP_URL/api/flap" 5 5
  sleep 10
done

echo "  Completed: $(date -u +%H:%M:%S\ UTC)"

# --- Phase 4: Recovery (1 minute of normal traffic) ---
echo "[Phase 4/4] Recovery — traffic returning to normal (1 minute)..."
echo "  Started: $(date -u +%H:%M:%S\ UTC)"

for i in $(seq 1 12); do
  send_requests "$APP_URL/health" 2 2
  send_requests "$APP_URL/api/data" 1 1
  sleep 5
done

echo "  Completed: $(date -u +%H:%M:%S\ UTC)"

echo ""
echo "=== Load generation complete ==="
echo "Total duration: ~8 minutes"
echo "Wait 3-5 minutes for telemetry to appear in Application Insights."
