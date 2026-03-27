#!/usr/bin/env bash
set -euo pipefail

# AZ Doctor Demo — AKS Cascading Failure Generator
#
# Scenario: Memory leak → OOMKill → CrashLoopBackOff → leaked DB connections → PostgreSQL exhaustion
#
# 1. Steady requests cause memory to grow (500KB leaked per request)
# 2. At ~256MB, container hits memory limit → OOMKilled (exit code 137)
# 3. Kubernetes restarts pod → crash loop begins
# 4. During crash cycles, PostgreSQL connections aren't released
# 5. PostgreSQL max_connections approached → other pods affected

AKS_URL="${1:?Usage: generate-aks-load.sh <AKS_EXTERNAL_IP_OR_URL>}"

# Ensure URL has http://
if [[ ! "$AKS_URL" =~ ^http ]]; then
  AKS_URL="http://$AKS_URL"
fi

echo "=== AZ Doctor AKS Load Generator ==="
echo "Target: $AKS_URL"
echo "Scenario: Memory leak → OOMKill → CrashLoop → PostgreSQL connection exhaustion"
echo ""

send_requests() {
  local url="$1"
  local count="$2"
  local concurrency="${3:-5}"

  for i in $(seq 1 "$count"); do
    curl -s -o /dev/null --max-time 15 "$url" &
    if (( i % concurrency == 0 )); then
      wait
    fi
  done
  wait
}

# --- Phase 1: Normal traffic (1 min) ---
echo "[Phase 1/3] Normal traffic — establishing baseline (1 minute)..."
echo "  Started: $(date -u +%H:%M:%S\ UTC)"

for i in $(seq 1 12); do
  send_requests "$AKS_URL/health" 3 3
  send_requests "$AKS_URL/api/data" 2 2
  sleep 5
done

echo "  Completed: $(date -u +%H:%M:%S\ UTC)"

# --- Phase 2: Ramp up — trigger memory leak (5 min) ---
echo "[Phase 2/3] Ramping up — triggering memory leak across pods (5 minutes)..."
echo "  Started: $(date -u +%H:%M:%S\ UTC)"
echo "  Each /api/data request leaks ~500KB. At 256MB limit, pods will OOMKill."

for i in $(seq 1 60); do
  # Hit /api/data hard — each request leaks 500KB and opens a PostgreSQL connection
  send_requests "$AKS_URL/api/data" 10 10
  sleep 5

  # Check memory growth periodically
  if (( i % 10 == 0 )); then
    mem=$(curl -s --max-time 5 "$AKS_URL/health" 2>/dev/null | grep -o '"memoryMB":[0-9]*' | head -1 || echo "unknown")
    echo "  [$i/60] Memory: $mem"
  fi
done

echo "  Completed: $(date -u +%H:%M:%S\ UTC)"

# --- Phase 3: Sustained pressure during crash loops (3 min) ---
echo "[Phase 3/3] Sustained pressure — pods crashing, connections leaking (3 minutes)..."
echo "  Started: $(date -u +%H:%M:%S\ UTC)"
echo "  Pods should be in CrashLoopBackOff. New requests hit remaining healthy pods harder."

for i in $(seq 1 36); do
  send_requests "$AKS_URL/api/data" 15 15
  send_requests "$AKS_URL/health" 3 3
  sleep 5
done

echo "  Completed: $(date -u +%H:%M:%S\ UTC)"

echo ""
echo "=== AKS Load generation complete ==="
echo "Total duration: ~9 minutes"
echo ""
echo "Check pod status:"
echo "  kubectl get pods -l app=azdemo-api"
echo ""
echo "Expected state:"
echo "  - Some pods in CrashLoopBackOff (OOMKilled)"
echo "  - Pod restart counts > 3"
echo "  - PostgreSQL connections elevated"
echo ""
echo "Wait 3-5 min for Container Insights data, then investigate with AZ Doctor:"
echo "  Investigate aks-azdemo-prod in resource group azdoctor-demo-prod"
