import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Mock azure-client before importing any tools
// vi.hoisted ensures the variable is available when vi.mock's factory runs
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  resolveSubscription: vi.fn().mockResolvedValue("mock-sub-id"),

  queryResourceGraph: vi.fn().mockResolvedValue({
    resources: [
      {
        id: "/subscriptions/mock-sub-id/resourceGroups/test-rg/providers/Microsoft.Web/sites/test-app",
        name: "test-app",
        type: "Microsoft.Web/sites",
        location: "eastus",
        resourceGroup: "test-rg",
      },
    ],
    totalRecords: 1,
  }),

  getResourceHealth: vi.fn().mockResolvedValue({
    statuses: [
      {
        properties: {
          availabilityState: "Available",
          summary: "Resource is healthy",
        },
      },
    ],
  }),

  batchResourceHealth: vi.fn().mockResolvedValue({
    statuses: [
      {
        name: "test-app",
        type: "Microsoft.Web/sites",
        properties: { availabilityState: "Available" },
      },
    ],
  }),

  getActivityLogs: vi.fn().mockResolvedValue({
    events: [
      {
        operationName: {
          localizedValue: "Update Web App",
          value: "Microsoft.Web/sites/write",
        },
        status: { value: "Succeeded" },
        eventTimestamp: new Date("2024-01-15T10:00:00Z"),
        caller: "user@example.com",
        resourceId:
          "/subscriptions/mock-sub-id/resourceGroups/test-rg/providers/Microsoft.Web/sites/test-app",
      },
    ],
  }),

  getMetrics: vi.fn().mockResolvedValue({
    data: {
      metrics: [
        {
          name: "CpuPercentage",
          timeseries: [
            {
              data: [
                {
                  timeStamp: new Date("2024-01-15T09:00:00Z"),
                  average: 45,
                  maximum: 55,
                },
                {
                  timeStamp: new Date("2024-01-15T10:00:00Z"),
                  average: 50,
                  maximum: 60,
                },
              ],
            },
          ],
        },
      ],
    },
  }),

  batchExecute: vi
    .fn()
    .mockImplementation(
      async (tasks: (() => Promise<unknown>)[], _batchSize: number) => {
        return Promise.all(tasks.map((t) => t()));
      },
    ),

  discoverWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),

  queryLogAnalytics: vi.fn().mockResolvedValue({ tables: [] }),

  createMetricsQueryClient: vi.fn().mockReturnValue({}),
}));

vi.mock("../utils/azure-client.js", () => mocks);

// ---------------------------------------------------------------------------
// Import tool registration functions (AFTER mocking)
// ---------------------------------------------------------------------------

import { registerHealthcheck } from "./healthcheck.js";
import { registerInvestigate } from "./investigate.js";
import { registerRca } from "./rca.js";
import { registerCheckPermissions } from "./checkPermissions.js";
import { registerCompare } from "./compare.js";

// ---------------------------------------------------------------------------
// Helper: create a mock McpServer that captures tool handlers
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function createMockServer(): {
  server: McpServer;
  handlers: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((...args: unknown[]) => {
      // The 4-arg overload: (name, description, schema, handler)
      const name = args[0] as string;
      const handler = args[args.length - 1] as ToolHandler;
      handlers.set(name, handler);
    }),
  } as unknown as McpServer;
  return { server, handlers };
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tool Registration", () => {
  it("should register azdoctor_healthcheck without error", () => {
    const { server, handlers } = createMockServer();
    registerHealthcheck(server);
    expect(handlers.has("azdoctor_healthcheck")).toBe(true);
  });

  it("should register azdoctor_investigate without error", () => {
    const { server, handlers } = createMockServer();
    registerInvestigate(server);
    expect(handlers.has("azdoctor_investigate")).toBe(true);
  });

  it("should register azdoctor_rca without error", () => {
    const { server, handlers } = createMockServer();
    registerRca(server);
    expect(handlers.has("azdoctor_rca")).toBe(true);
  });

  it("should register azdoctor_check_permissions without error", () => {
    const { server, handlers } = createMockServer();
    registerCheckPermissions(server);
    expect(handlers.has("azdoctor_check_permissions")).toBe(true);
  });

  it("should register azdoctor_compare without error", () => {
    const { server, handlers } = createMockServer();
    registerCompare(server);
    expect(handlers.has("azdoctor_compare")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// azdoctor_healthcheck
// ---------------------------------------------------------------------------

describe("azdoctor_healthcheck", () => {
  let handler: ToolHandler;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset default happy-path mocks
    mocks.resolveSubscription.mockResolvedValue("mock-sub-id");
    mocks.queryResourceGraph.mockResolvedValue({
      resources: [
        {
          id: "/subscriptions/mock-sub-id/resourceGroups/test-rg/providers/Microsoft.Web/sites/test-app",
          name: "test-app",
          type: "Microsoft.Web/sites",
          location: "eastus",
          resourceGroup: "test-rg",
        },
      ],
      totalRecords: 1,
    });
    mocks.batchResourceHealth.mockResolvedValue({
      statuses: [
        {
          name: "test-app",
          type: "Microsoft.Web/sites",
          properties: { availabilityState: "Available" },
        },
      ],
    });
    mocks.getActivityLogs.mockResolvedValue({
      events: [
        {
          operationName: {
            localizedValue: "Update Web App",
            value: "Microsoft.Web/sites/write",
          },
          status: { value: "Succeeded" },
          eventTimestamp: new Date("2024-01-15T10:00:00Z"),
          caller: "user@example.com",
          resourceId:
            "/subscriptions/mock-sub-id/resourceGroups/test-rg/providers/Microsoft.Web/sites/test-app",
        },
      ],
    });

    const { server, handlers } = createMockServer();
    registerHealthcheck(server);
    handler = handlers.get("azdoctor_healthcheck")!;
  });

  it("should return findings with riskScore for healthy subscription", async () => {
    const result = await handler({ severity: "warning" });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.riskScore).toBeDefined();
    expect(typeof parsed.riskScore).toBe("number");
    expect(parsed.findings).toBeDefined();
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.scannedResources).toBeDefined();
    expect(parsed.timestamp).toBeDefined();
  });

  it("should flag unavailable resources as critical", async () => {
    mocks.batchResourceHealth.mockResolvedValue({
      statuses: [
        {
          name: "sick-app",
          type: "Microsoft.Web/sites",
          properties: {
            availabilityState: "Unavailable",
            summary: "Platform issue detected",
            reasonType: "PlatformInitiated",
          },
        },
      ],
    });

    const result = await handler({ severity: "warning" });
    const parsed = parseResult(result) as Record<string, unknown>;
    const findings = parsed.findings as Array<Record<string, unknown>>;

    const criticalFinding = findings.find((f) => f.severity === "critical");
    expect(criticalFinding).toBeDefined();
    expect(criticalFinding!.resource).toBe("sick-app");
    expect((criticalFinding!.issue as string)).toContain("unavailable");
  });

  it("should flag failed deployments as warning", async () => {
    mocks.getActivityLogs.mockResolvedValue({
      events: [
        {
          operationName: {
            localizedValue: "Create Deployment",
            value: "Microsoft.Resources/deployments/write",
          },
          status: { value: "Failed" },
          eventTimestamp: new Date("2024-01-15T10:00:00Z"),
          caller: "deploy-bot@example.com",
          resourceId:
            "/subscriptions/mock-sub-id/resourceGroups/test-rg/providers/Microsoft.Resources/deployments/my-deploy",
        },
      ],
    });

    const result = await handler({ severity: "warning" });
    const parsed = parseResult(result) as Record<string, unknown>;
    const findings = parsed.findings as Array<Record<string, unknown>>;

    const warningFinding = findings.find(
      (f) =>
        f.severity === "warning" &&
        (f.issue as string).includes("Failed deployment"),
    );
    expect(warningFinding).toBeDefined();
    expect(warningFinding!.resourceType).toBe(
      "Microsoft.Resources/deployments",
    );
  });

  it("should respect severity filter threshold", async () => {
    // With severity=critical, info/warning findings should be excluded
    mocks.batchResourceHealth.mockResolvedValue({
      statuses: [
        {
          name: "test-app",
          type: "Microsoft.Web/sites",
          properties: { availabilityState: "Available" },
        },
      ],
    });

    const result = await handler({ severity: "critical" });
    const parsed = parseResult(result) as Record<string, unknown>;
    const findings = parsed.findings as Array<Record<string, unknown>>;

    // All findings (if any) should be critical
    for (const f of findings) {
      expect(f.severity).toBe("critical");
    }
  });
});

// ---------------------------------------------------------------------------
// azdoctor_investigate
// ---------------------------------------------------------------------------

describe("azdoctor_investigate", () => {
  let handler: ToolHandler;

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.resolveSubscription.mockResolvedValue("mock-sub-id");
    mocks.queryResourceGraph.mockResolvedValue({
      resources: [
        {
          id: "/subscriptions/mock-sub-id/resourceGroups/test-rg/providers/Microsoft.Web/sites/test-app",
          name: "test-app",
          type: "Microsoft.Web/sites",
          location: "eastus",
          resourceGroup: "test-rg",
        },
      ],
      totalRecords: 1,
    });
    mocks.getResourceHealth.mockResolvedValue({
      statuses: [
        {
          properties: {
            availabilityState: "Available",
            summary: "Resource is healthy",
          },
        },
      ],
    });
    mocks.getActivityLogs.mockResolvedValue({
      events: [
        {
          operationName: {
            localizedValue: "Update Web App",
            value: "Microsoft.Web/sites/write",
          },
          status: { value: "Succeeded" },
          eventTimestamp: new Date("2024-01-15T10:00:00Z"),
          caller: "user@example.com",
          resourceId:
            "/subscriptions/mock-sub-id/resourceGroups/test-rg/providers/Microsoft.Web/sites/test-app",
        },
      ],
    });
    mocks.getMetrics.mockResolvedValue({
      data: {
        metrics: [
          {
            name: "CpuPercentage",
            timeseries: [
              {
                data: [
                  {
                    timeStamp: new Date("2024-01-15T09:00:00Z"),
                    average: 45,
                    maximum: 55,
                  },
                  {
                    timeStamp: new Date("2024-01-15T10:00:00Z"),
                    average: 50,
                    maximum: 60,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    mocks.batchExecute.mockImplementation(
      async (tasks: (() => Promise<unknown>)[], _batchSize: number) => {
        return Promise.all(tasks.map((t) => t()));
      },
    );
    mocks.discoverWorkspaces.mockResolvedValue({ workspaces: [] });

    const { server, handlers } = createMockServer();
    registerInvestigate(server);
    handler = handlers.get("azdoctor_investigate")!;
  });

  it("should resolve resource by name and return investigation", async () => {
    const result = await handler({
      resource: "test-app",
      timeframeHours: 24,
    });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.resource).toBe("test-app");
    expect(parsed.resourceType).toBe("Microsoft.Web/sites");
    expect(parsed.currentHealth).toBe("Available");
    expect(parsed.timeline).toBeDefined();
    expect(Array.isArray(parsed.timeline)).toBe(true);
    expect(parsed.likelyCause).toBeDefined();
  });

  it("should handle full resource ID input", async () => {
    const fullId =
      "/subscriptions/mock-sub-id/resourceGroups/test-rg/providers/Microsoft.Web/sites/test-app";

    const result = await handler({
      resource: fullId,
      timeframeHours: 24,
    });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.resource).toBe("test-app");
    expect(parsed.resourceType).toBe("Microsoft.Web/sites");

    // When a full ID is provided, it should NOT call queryResourceGraph for resolution
    // (it's still called for dependency queries though). The first call should be
    // for dependency discovery, not name resolution.
    const rgCalls = mocks.queryResourceGraph.mock.calls;
    const hasResolveCall = rgCalls.some(
      (call: unknown[]) =>
        typeof call[1] === "string" &&
        (call[1] as string).includes("where name =~"),
    );
    expect(hasResolveCall).toBe(false);
  });

  it("should include confidence and cascadingFailure in response", async () => {
    const result = await handler({
      resource: "test-app",
      timeframeHours: 24,
    });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.confidence).toBeDefined();
    expect(["high", "medium", "low"]).toContain(parsed.confidence);
    expect(typeof parsed.cascadingFailure).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// azdoctor_rca
// ---------------------------------------------------------------------------

describe("azdoctor_rca", () => {
  let handler: ToolHandler;

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.resolveSubscription.mockResolvedValue("mock-sub-id");
    mocks.queryResourceGraph.mockResolvedValue({
      resources: [
        {
          id: "/subscriptions/mock-sub-id/resourceGroups/test-rg/providers/Microsoft.Web/sites/test-app",
          name: "test-app",
          type: "Microsoft.Web/sites",
          location: "eastus",
          resourceGroup: "test-rg",
        },
      ],
      totalRecords: 1,
    });
    mocks.getResourceHealth.mockResolvedValue({
      statuses: [
        {
          properties: {
            availabilityState: "Available",
            summary: "Resource is healthy",
          },
        },
      ],
    });
    mocks.getActivityLogs.mockResolvedValue({
      events: [
        {
          operationName: {
            localizedValue: "Update Web App",
            value: "Microsoft.Web/sites/write",
          },
          status: { value: "Succeeded" },
          eventTimestamp: new Date("2024-01-15T10:00:00Z"),
          caller: "user@example.com",
          resourceId:
            "/subscriptions/mock-sub-id/resourceGroups/test-rg/providers/Microsoft.Web/sites/test-app",
        },
      ],
    });
    mocks.getMetrics.mockResolvedValue({
      data: {
        metrics: [
          {
            name: "CpuPercentage",
            timeseries: [
              {
                data: [
                  {
                    timeStamp: new Date("2024-01-15T09:00:00Z"),
                    average: 45,
                    maximum: 55,
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const { server, handlers } = createMockServer();
    registerRca(server);
    handler = handlers.get("azdoctor_rca")!;
  });

  it("should generate markdown RCA by default", async () => {
    const result = await handler({
      resource: "test-app",
      outputFormat: "markdown",
    });
    const text = result.content[0].text;

    expect(text).toContain("## Root Cause Analysis");
    expect(text).toContain("test-app");
    expect(text).toContain("### Timeline");
    expect(text).toContain("### Root Cause");
  });

  it("should return JSON when outputFormat is json", async () => {
    const result = await handler({
      resource: "test-app",
      outputFormat: "json",
      includeRecommendations: true,
    });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.confidence).toBeDefined();
    expect(["high", "medium", "low"]).toContain(parsed.confidence);
    expect(parsed.resource).toBe("test-app");
    expect(parsed.resourceType).toBe("Microsoft.Web/sites");
    expect(parsed.cascadingFailure).toBeDefined();
    expect(parsed.generatedAt).toBeDefined();
  });

  it("should include incident window from provided timestamps", async () => {
    const result = await handler({
      resource: "test-app",
      outputFormat: "json",
      incidentStart: "2024-01-15T08:00:00Z",
      incidentEnd: "2024-01-15T12:00:00Z",
      includeRecommendations: true,
    });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.incidentStart).toBe("2024-01-15T08:00:00Z");
    expect(parsed.incidentEnd).toBe("2024-01-15T12:00:00Z");
    const impact = parsed.impact as Record<string, unknown>;
    expect(impact.duration).toBe("4h 0m");
  });
});

// ---------------------------------------------------------------------------
// azdoctor_check_permissions
// ---------------------------------------------------------------------------

describe("azdoctor_check_permissions", () => {
  let handler: ToolHandler;

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.resolveSubscription.mockResolvedValue("mock-sub-id");
    mocks.queryResourceGraph.mockResolvedValue({
      resources: [{ id: "test", name: "test", type: "test" }],
      totalRecords: 1,
    });
    mocks.batchResourceHealth.mockResolvedValue({
      statuses: [
        {
          name: "test",
          properties: { availabilityState: "Available" },
        },
      ],
    });
    mocks.getActivityLogs.mockResolvedValue({ events: [] });
    mocks.createMetricsQueryClient.mockReturnValue({});

    const { server, handlers } = createMockServer();
    registerCheckPermissions(server);
    handler = handlers.get("azdoctor_check_permissions")!;
  });

  it("should return overallReadiness based on probe results", async () => {
    const result = await handler({});
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.overallReadiness).toBeDefined();
    expect(["full", "partial", "none"]).toContain(parsed.overallReadiness);
    expect(parsed.checks).toBeDefined();
    expect(parsed.subscription).toBe("mock-sub-id");
  });

  it("should report accessible APIs as ok", async () => {
    const result = await handler({});
    const parsed = parseResult(result) as Record<string, unknown>;
    const checks = parsed.checks as Record<
      string,
      Record<string, unknown>
    >;

    expect(checks.resourceGraph.status).toBe("ok");
    expect(checks.resourceGraph.accessible).toBe(true);
    expect(checks.resourceHealth.status).toBe("ok");
    expect(checks.activityLog.status).toBe("ok");
  });

  it("should indicate requires_resource for metrics without resourceId", async () => {
    const result = await handler({});
    const parsed = parseResult(result) as Record<string, unknown>;
    const checks = parsed.checks as Record<
      string,
      Record<string, unknown>
    >;

    expect(checks.metrics.status).toBe("requires_resource");
  });
});

// ---------------------------------------------------------------------------
// azdoctor_compare
// ---------------------------------------------------------------------------

describe("azdoctor_compare", () => {
  let handler: ToolHandler;

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.resolveSubscription.mockResolvedValue("mock-sub-id");

    // Default: both scopes return identical data
    mocks.queryResourceGraph.mockResolvedValue({
      resources: [
        { type: "Microsoft.Web/sites", count_: 2 },
      ],
      totalRecords: 2,
    });
    mocks.batchResourceHealth.mockResolvedValue({
      statuses: [
        {
          name: "app1",
          properties: { availabilityState: "Available" },
        },
      ],
    });
    mocks.getActivityLogs.mockResolvedValue({
      events: [
        {
          operationName: { value: "write" },
          status: { value: "Succeeded" },
          eventTimestamp: new Date(),
        },
      ],
    });

    const { server, handlers } = createMockServer();
    registerCompare(server);
    handler = handlers.get("azdoctor_compare")!;
  });

  it("should compare two resource groups and return parity", async () => {
    const result = await handler({
      scopeA: "rg-prod",
      scopeB: "rg-staging",
      mode: "full",
    });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.scopeA).toBeDefined();
    expect(parsed.scopeB).toBeDefined();
    expect(parsed.differences).toBeDefined();
    expect(Array.isArray(parsed.differences)).toBe(true);
    expect(parsed.parity).toBeDefined();
    expect(["matched", "partial", "divergent"]).toContain(parsed.parity);
    expect(parsed.timestamp).toBeDefined();
  });

  it("should detect health divergence between scopes", async () => {
    let callCount = 0;
    mocks.batchResourceHealth.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Scope A: has unhealthy resource
        return {
          statuses: [
            {
              name: "sick-app",
              properties: { availabilityState: "Unavailable" },
            },
          ],
        };
      }
      // Scope B: healthy
      return {
        statuses: [
          {
            name: "healthy-app",
            properties: { availabilityState: "Available" },
          },
        ],
      };
    });

    const result = await handler({
      scopeA: "rg-prod",
      scopeB: "rg-staging",
      mode: "full",
    });
    const parsed = parseResult(result) as Record<string, unknown>;
    const differences = parsed.differences as Array<Record<string, unknown>>;

    const healthDiff = differences.find((d) => d.category === "health");
    expect(healthDiff).toBeDefined();
    expect(healthDiff!.severity).toBe("critical");
    expect(parsed.parity).toBe("divergent");
  });

  it("should report matched parity when scopes are identical", async () => {
    const result = await handler({
      scopeA: "rg-prod",
      scopeB: "rg-staging",
      mode: "full",
    });
    const parsed = parseResult(result) as Record<string, unknown>;

    // Both scopes return identical mock data
    expect(parsed.parity).toBe("matched");
  });
});
