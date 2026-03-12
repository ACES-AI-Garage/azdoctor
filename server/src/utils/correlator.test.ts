import { describe, it, expect } from "vitest";
import {
  correlateTimelines,
  clusterEvents,
  detectMetricAnomalies,
  detectChangeVelocity,
  DiagnosticEvent,
} from "./correlator.js";

// ---------------------------------------------------------------------------
// Helpers to build realistic Azure-like events
// ---------------------------------------------------------------------------

function makeChange(
  time: string,
  event: string,
  opts: { resource?: string; actor?: string } = {}
): DiagnosticEvent {
  return {
    time,
    event,
    source: "ActivityLog",
    resource: opts.resource ?? "prod-api",
    actor: opts.actor ?? "deploy-pipeline@contoso.com",
    severity: "info",
  };
}

function makeAnomaly(
  time: string,
  event: string,
  opts: {
    source?: "ResourceHealth" | "Metrics" | "ServiceHealth";
    resource?: string;
    severity?: "critical" | "warning" | "info";
  } = {}
): DiagnosticEvent {
  return {
    time,
    event,
    source: opts.source ?? "ResourceHealth",
    resource: opts.resource ?? "prod-api",
    severity: opts.severity ?? "critical",
  };
}

// ---------------------------------------------------------------------------
// correlateTimelines
// ---------------------------------------------------------------------------

describe("correlateTimelines", () => {
  it("returns insufficient data for empty events", () => {
    const result = correlateTimelines([]);
    expect(result.timeline).toEqual([]);
    expect(result.earliestAnomaly).toBeNull();
    expect(result.precedingChanges).toEqual([]);
    expect(result.likelyCause).toContain("insufficient data");
    expect(result.confidence).toBe("low");
    expect(result.cascadingFailure).toBe(false);
  });

  it("returns changes as precedingChanges when only changes exist (no anomalies)", () => {
    const events: DiagnosticEvent[] = [
      makeChange("2026-03-10T10:00:00Z", "Deployed v2.1 to prod-api"),
      makeChange("2026-03-10T10:05:00Z", "Updated NSG rules on prod-api"),
    ];
    const result = correlateTimelines(events);
    expect(result.earliestAnomaly).toBeNull();
    expect(result.precedingChanges).toHaveLength(2);
    expect(result.confidence).toBe("medium");
    expect(result.likelyCause).toContain("change(s) detected");
    expect(result.likelyCause).toContain("no anomalies");
    expect(result.cascadingFailure).toBe(false);
  });

  it("mentions no preceding changes when only anomalies exist", () => {
    const events: DiagnosticEvent[] = [
      makeAnomaly("2026-03-10T10:00:00Z", "Resource became Unavailable"),
    ];
    const result = correlateTimelines(events);
    expect(result.earliestAnomaly).not.toBeNull();
    expect(result.precedingChanges).toHaveLength(0);
    expect(result.confidence).toBe("medium");
    expect(result.likelyCause).toContain("No preceding changes");
  });

  it("identifies causal link when change precedes anomaly within 15min window", () => {
    const events: DiagnosticEvent[] = [
      makeChange("2026-03-10T10:00:00Z", "Deployed v2.1 to prod-api"),
      makeAnomaly("2026-03-10T10:10:00Z", "Resource became Unavailable"),
    ];
    const result = correlateTimelines(events);
    expect(result.earliestAnomaly).not.toBeNull();
    expect(result.precedingChanges).toHaveLength(1);
    expect(result.confidence).toBe("high");
    expect(result.likelyCause).toContain("likely triggered");
  });

  it("finds no preceding change when change is outside 15min window", () => {
    const events: DiagnosticEvent[] = [
      makeChange("2026-03-10T09:00:00Z", "Deployed v2.1 to prod-api"),
      makeAnomaly("2026-03-10T10:00:00Z", "Resource became Unavailable"),
    ];
    const result = correlateTimelines(events);
    expect(result.precedingChanges).toHaveLength(0);
    expect(result.confidence).toBe("medium");
    expect(result.likelyCause).toContain("No preceding changes");
  });

  it("identifies only the most recent change within the window", () => {
    const events: DiagnosticEvent[] = [
      makeChange("2026-03-10T09:50:00Z", "Updated App Settings"),
      makeChange("2026-03-10T09:55:00Z", "Scaled out to 4 instances"),
      makeChange("2026-03-10T09:58:00Z", "Deployed v2.2 to prod-api"),
      makeAnomaly("2026-03-10T10:00:00Z", "Resource became Unavailable"),
    ];
    const result = correlateTimelines(events);
    // All three changes are within the 15-min window, so all appear in precedingChanges
    expect(result.precedingChanges).toHaveLength(3);
    // The likelyCause should reference the most recent change (the last one)
    expect(result.likelyCause).toContain("Deployed v2.2");
    expect(result.confidence).toBe("high");
  });

  it("detects cascading failure when 3+ anomalies occur within 5 minutes", () => {
    const events: DiagnosticEvent[] = [
      makeChange("2026-03-10T09:55:00Z", "Deployed v2.2 to prod-api"),
      makeAnomaly("2026-03-10T10:00:00Z", "prod-api health degraded", {
        resource: "prod-api",
      }),
      makeAnomaly("2026-03-10T10:01:00Z", "prod-db connection failures", {
        resource: "prod-db",
        source: "Metrics",
      }),
      makeAnomaly("2026-03-10T10:02:00Z", "prod-cache eviction spike", {
        resource: "prod-cache",
        source: "Metrics",
      }),
    ];
    const result = correlateTimelines(events);
    expect(result.cascadingFailure).toBe(true);
    expect(result.likelyCause).toContain("Cascading failure");
  });

  it("does not flag cascading failure when anomalies are spread over hours", () => {
    const events: DiagnosticEvent[] = [
      makeAnomaly("2026-03-10T10:00:00Z", "CPU spike on prod-api", {
        source: "Metrics",
      }),
      makeAnomaly("2026-03-10T12:00:00Z", "Memory pressure on prod-api", {
        source: "Metrics",
      }),
      makeAnomaly("2026-03-10T14:00:00Z", "Disk IO spike on prod-api", {
        source: "Metrics",
      }),
    ];
    const result = correlateTimelines(events);
    expect(result.cascadingFailure).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clusterEvents
// ---------------------------------------------------------------------------

describe("clusterEvents", () => {
  it("returns empty array for empty events", () => {
    expect(clusterEvents([])).toEqual([]);
  });

  it("returns one cluster for a single event", () => {
    const events: DiagnosticEvent[] = [
      makeAnomaly("2026-03-10T10:00:00Z", "CPU spike on prod-api"),
    ];
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].events).toHaveLength(1);
    expect(clusters[0].startTime).toBe("2026-03-10T10:00:00Z");
    expect(clusters[0].endTime).toBe("2026-03-10T10:00:00Z");
  });

  it("groups events within 5 minutes into one cluster", () => {
    const events: DiagnosticEvent[] = [
      makeAnomaly("2026-03-10T10:00:00Z", "CPU spike"),
      makeAnomaly("2026-03-10T10:02:00Z", "Memory spike"),
      makeAnomaly("2026-03-10T10:04:00Z", "Disk IO spike"),
    ];
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].events).toHaveLength(3);
    expect(clusters[0].startTime).toBe("2026-03-10T10:00:00Z");
    expect(clusters[0].endTime).toBe("2026-03-10T10:04:00Z");
  });

  it("separates events more than 5 minutes apart into different clusters", () => {
    const events: DiagnosticEvent[] = [
      makeAnomaly("2026-03-10T10:00:00Z", "CPU spike"),
      makeAnomaly("2026-03-10T10:10:00Z", "Memory spike"),
    ];
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].events).toHaveLength(1);
    expect(clusters[1].events).toHaveLength(1);
  });

  it("sets cluster severity to the highest severity in the cluster", () => {
    const events: DiagnosticEvent[] = [
      makeAnomaly("2026-03-10T10:00:00Z", "Info event", {
        severity: "info",
      }),
      makeAnomaly("2026-03-10T10:01:00Z", "Warning event", {
        severity: "warning",
      }),
      makeAnomaly("2026-03-10T10:02:00Z", "Critical event", {
        severity: "critical",
      }),
    ];
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].severity).toBe("critical");
  });

  it("uses custom window size", () => {
    const events: DiagnosticEvent[] = [
      makeAnomaly("2026-03-10T10:00:00Z", "Event A"),
      makeAnomaly("2026-03-10T10:08:00Z", "Event B"),
    ];
    // Default 5min window -> separate clusters
    expect(clusterEvents(events, 5)).toHaveLength(2);
    // 10min window -> single cluster
    expect(clusterEvents(events, 10)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detectMetricAnomalies
// ---------------------------------------------------------------------------

describe("detectMetricAnomalies", () => {
  const thresholds = { warningPct: 70, criticalPct: 90 };
  const resourceId = "/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Web/sites/prod-api";
  const metricName = "CpuPercentage";

  it("returns no events when value is below warning threshold", () => {
    const events = detectMetricAnomalies(resourceId, metricName, [
      { timestamp: "2026-03-10T10:00:00Z", average: 50 },
    ], thresholds);
    expect(events).toHaveLength(0);
  });

  it("returns a warning event when value is at warning threshold", () => {
    const events = detectMetricAnomalies(resourceId, metricName, [
      { timestamp: "2026-03-10T10:00:00Z", average: 70 },
    ], thresholds);
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("warning");
    expect(events[0].source).toBe("Metrics");
    expect(events[0].resource).toBe(resourceId);
    expect(events[0].event).toContain("warning threshold");
  });

  it("returns a critical event when value is at critical threshold", () => {
    const events = detectMetricAnomalies(resourceId, metricName, [
      { timestamp: "2026-03-10T10:00:00Z", average: 95 },
    ], thresholds);
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("critical");
    expect(events[0].event).toContain("critical threshold");
  });

  it("uses maximum over average when both are present", () => {
    // average is below warning but maximum is critical
    const events = detectMetricAnomalies(resourceId, metricName, [
      { timestamp: "2026-03-10T10:00:00Z", average: 50, maximum: 95 },
    ], thresholds);
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("critical");
    expect(events[0].event).toContain("95.0%");
  });

  it("handles undefined values gracefully", () => {
    const events = detectMetricAnomalies(resourceId, metricName, [
      { timestamp: "2026-03-10T10:00:00Z" },
      { timestamp: "2026-03-10T10:05:00Z", average: undefined, maximum: undefined },
    ], thresholds);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectChangeVelocity
// ---------------------------------------------------------------------------

describe("detectChangeVelocity", () => {
  it("returns no high velocity periods when fewer than threshold changes", () => {
    const events: DiagnosticEvent[] = [
      makeChange("2026-03-10T10:00:00Z", "Deploy A"),
      makeChange("2026-03-10T10:05:00Z", "Deploy B"),
    ];
    const result = detectChangeVelocity(events, 30, 5);
    expect(result.highVelocityPeriods).toHaveLength(0);
  });

  it("detects a burst of changes exceeding threshold", () => {
    const events: DiagnosticEvent[] = [
      makeChange("2026-03-10T10:00:00Z", "Deploy A", { actor: "alice@contoso.com" }),
      makeChange("2026-03-10T10:05:00Z", "Deploy B", { actor: "alice@contoso.com" }),
      makeChange("2026-03-10T10:10:00Z", "Config update", { actor: "bob@contoso.com" }),
      makeChange("2026-03-10T10:15:00Z", "Scale out", { actor: "alice@contoso.com" }),
      makeChange("2026-03-10T10:20:00Z", "NSG rule change", { actor: "bob@contoso.com" }),
    ];
    const result = detectChangeVelocity(events, 30, 5);
    expect(result.highVelocityPeriods).toHaveLength(1);
    expect(result.highVelocityPeriods[0].changeCount).toBeGreaterThanOrEqual(5);
    expect(result.highVelocityPeriods[0].actors).toContain("alice@contoso.com");
    expect(result.highVelocityPeriods[0].actors).toContain("bob@contoso.com");
  });

  it("detects multiple separate bursts", () => {
    // First burst: 5 changes within 30 min
    const burst1: DiagnosticEvent[] = Array.from({ length: 5 }, (_, i) =>
      makeChange(
        `2026-03-10T10:${String(i * 5).padStart(2, "0")}:00Z`,
        `Burst1 change ${i}`,
        { actor: "alice@contoso.com" }
      )
    );
    // Second burst: 5 changes within 30 min, 3 hours later
    const burst2: DiagnosticEvent[] = Array.from({ length: 5 }, (_, i) =>
      makeChange(
        `2026-03-10T13:${String(i * 5).padStart(2, "0")}:00Z`,
        `Burst2 change ${i}`,
        { actor: "bob@contoso.com" }
      )
    );
    const result = detectChangeVelocity([...burst1, ...burst2], 30, 5);
    expect(result.highVelocityPeriods).toHaveLength(2);
  });

  it("respects custom window and threshold", () => {
    const events: DiagnosticEvent[] = [
      makeChange("2026-03-10T10:00:00Z", "Change 1"),
      makeChange("2026-03-10T10:02:00Z", "Change 2"),
      makeChange("2026-03-10T10:04:00Z", "Change 3"),
    ];
    // With threshold=3 and window=10min, should detect
    const result = detectChangeVelocity(events, 10, 3);
    expect(result.highVelocityPeriods).toHaveLength(1);
    expect(result.highVelocityPeriods[0].changeCount).toBe(3);

    // With threshold=5, should not detect
    const result2 = detectChangeVelocity(events, 10, 5);
    expect(result2.highVelocityPeriods).toHaveLength(0);
  });
});
