import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLAYBOOKS_DIR = join(homedir(), ".azdoctor", "playbooks");

// ---------------------------------------------------------------------------
// Playbook Frontmatter Types
// ---------------------------------------------------------------------------

interface PlaybookTriggers {
  resourceTypes: string[];
  patterns: string[];
  metrics: string[];
  symptoms: string[];
}

interface PlaybookFrontmatter {
  name: string;
  description: string;
  triggers: PlaybookTriggers;
  severity: string;
}

interface ParsedPlaybook {
  frontmatter: PlaybookFrontmatter;
  body: string;
  fileName: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Simple YAML Frontmatter Parser
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): {
  frontmatter: PlaybookFrontmatter | null;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: null, body: content };
  }

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return { frontmatter: null, body: content };
  }

  const yamlBlock = trimmed.substring(3, endIndex).trim();
  const body = trimmed.substring(endIndex + 3).trim();

  try {
    const parsed = parseSimpleYaml(yamlBlock);
    const triggers = (parsed["triggers"] as Record<string, unknown>) ?? {};
    const frontmatter: PlaybookFrontmatter = {
      name: String(parsed["name"] ?? ""),
      description: String(parsed["description"] ?? ""),
      triggers: {
        resourceTypes: toStringArray(triggers["resourceTypes"]),
        patterns: toStringArray(triggers["patterns"]),
        metrics: toStringArray(triggers["metrics"]),
        symptoms: toStringArray(triggers["symptoms"]),
      },
      severity: String(parsed["severity"] ?? "info"),
    };
    return { frontmatter, body };
  } catch {
    return { frontmatter: null, body: content };
  }
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [];
}

/**
 * Parse a simple YAML block. Handles:
 * - key: value pairs
 * - One level of nesting (indented keys under a parent)
 * - Arrays (lines starting with "  - value")
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");

  let currentKey: string | null = null;
  let currentNested: Record<string, unknown> | null = null;
  let currentArrayKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const rawLine of lines) {
    // Skip blank lines
    if (rawLine.trim() === "") continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    // Array item at any indent level
    if (line.startsWith("- ")) {
      const value = line.substring(2).trim();
      if (currentArray !== null && currentArrayKey !== null) {
        currentArray.push(value);
        continue;
      }
    }

    // Flush any pending array
    if (currentArray !== null && currentArrayKey !== null) {
      if (currentNested !== null) {
        currentNested[currentArrayKey] = currentArray;
      } else {
        result[currentArrayKey] = currentArray;
      }
      currentArray = null;
      currentArrayKey = null;
    }

    // Check for key: value
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.substring(0, colonIndex).trim();
    const valueStr = line.substring(colonIndex + 1).trim();

    if (indent === 0) {
      // Flush any pending nested object
      if (currentKey !== null && currentNested !== null) {
        result[currentKey] = currentNested;
        currentNested = null;
      }

      if (valueStr === "") {
        // Start of a nested object or array list
        currentKey = key;
        currentNested = {};
      } else {
        currentKey = null;
        currentNested = null;
        result[key] = valueStr;
      }
    } else if (indent > 0 && currentKey !== null) {
      // Nested key
      if (valueStr === "") {
        // This key will have array children
        currentArrayKey = key;
        currentArray = [];
      } else {
        if (currentNested !== null) {
          currentNested[key] = valueStr;
        }
      }
    }
  }

  // Flush final pending state
  if (currentArray !== null && currentArrayKey !== null) {
    if (currentNested !== null) {
      currentNested[currentArrayKey] = currentArray;
    } else {
      result[currentArrayKey] = currentArray;
    }
  }
  if (currentKey !== null && currentNested !== null) {
    result[currentKey] = currentNested;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Playbook Loading
// ---------------------------------------------------------------------------

function loadPlaybooks(): ParsedPlaybook[] {
  if (!existsSync(PLAYBOOKS_DIR)) return [];

  const files = readdirSync(PLAYBOOKS_DIR).filter((f) => f.endsWith(".md"));
  const playbooks: ParsedPlaybook[] = [];

  for (const fileName of files) {
    try {
      const filePath = join(PLAYBOOKS_DIR, fileName);
      const raw = readFileSync(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);
      if (frontmatter && frontmatter.name) {
        playbooks.push({ frontmatter, body, fileName, raw });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return playbooks;
}

// ---------------------------------------------------------------------------
// Sample Playbooks
// ---------------------------------------------------------------------------

const SAMPLE_HIGH_MEMORY = `---
name: high-memory-app-service
description: Diagnose and resolve high memory usage on App Service
triggers:
  resourceTypes:
    - microsoft.web/sites
    - microsoft.web/serverfarms
  patterns:
    - memory_exhaustion
    - cpu_saturation
  metrics:
    - MemoryPercentage
    - CpuPercentage
  symptoms:
    - slow
    - oom
    - out of memory
    - high memory
severity: warning
---

# High Memory on App Service

## Diagnosis Steps

1. Check if the App Service Plan is shared with other apps that may be consuming memory
2. Review Application Insights for memory-intensive operations
3. Check for memory leaks by comparing memory trends over 24h vs 7d
4. Look for recent deployments that may have introduced memory regression

## Common Root Causes

- **Memory leak in application code** — memory grows steadily over time without releasing
- **Large in-memory caches** — application caching too much data
- **Oversized payloads** — processing large files or responses in memory
- **Too many apps on shared plan** — noisy neighbor effect

## Remediation

1. **Immediate**: Restart the App Service to reclaim memory
2. **Short-term**: Scale up the App Service Plan to a higher memory tier
3. **Long-term**: Profile the application for memory leaks, optimize caching strategy

## Escalation

If memory usage returns to high levels within 1 hour after restart, the application likely has a memory leak. Engage the development team for profiling.
`;

const SAMPLE_CONNECTION_FAILURES = `---
name: database-connection-failures
description: Diagnose database connection failures and pool exhaustion
triggers:
  resourceTypes:
    - microsoft.sql/servers/databases
    - microsoft.dbformysql/flexibleservers
    - microsoft.dbforpostgresql/flexibleservers
  patterns:
    - connection_storm
    - dtu_exhaustion
  metrics:
    - connection_failed
    - dtu_consumption_percent
  symptoms:
    - connection
    - timeout
    - pool
    - cannot connect
severity: critical
---

# Database Connection Failures

## Diagnosis Steps

1. Check connection_failed metric for spike timing
2. Correlate with activity logs for recent firewall rule or configuration changes
3. Check DTU/CPU consumption — connection failures often accompany resource exhaustion
4. Verify connection string and firewall rules haven't changed
5. Check if connection pool settings match the database tier's max connections

## Common Root Causes

- **Connection pool exhaustion** — application not releasing connections
- **Database tier too small** — max connections exceeded for the tier
- **Firewall rule changes** — recent network configuration blocking connections
- **Password rotation** — credentials expired or rotated without app update

## Remediation

1. **Immediate**: Check and increase the database tier if DTU is saturated
2. **Short-term**: Review application connection pool settings (min/max pool size, timeout)
3. **Long-term**: Implement connection retry logic with exponential backoff
`;

// ---------------------------------------------------------------------------
// Match Logic
// ---------------------------------------------------------------------------

interface MatchResult {
  name: string;
  description: string;
  relevance: "high" | "medium" | "low";
  matchedTriggers: string[];
  content: string;
}

function matchPlaybooks(
  playbooks: ParsedPlaybook[],
  context: Record<string, unknown>
): MatchResult[] {
  const results: MatchResult[] = [];

  // Extract matching data from investigation context
  const resourceType = String(context["resourceType"] ?? context["resource_type"] ?? "").toLowerCase();
  const detectedPatterns: string[] = extractStringArray(context, "patterns", "detectedPatterns", "diagnosticPatterns");
  const anomalousMetrics: string[] = extractStringArray(context, "metrics", "anomalousMetrics", "metricNames");
  const symptoms: string[] = extractStringArray(context, "symptoms", "userSymptoms", "description");

  // Also check for a description string that might contain symptom keywords
  const descriptionText = String(context["description"] ?? context["symptom"] ?? context["issue"] ?? "").toLowerCase();

  for (const playbook of playbooks) {
    const matchedTriggers: string[] = [];
    const triggers = playbook.frontmatter.triggers;

    // Check resource type match
    if (resourceType && triggers.resourceTypes.length > 0) {
      for (const rt of triggers.resourceTypes) {
        if (resourceType.includes(rt.toLowerCase()) || rt.toLowerCase().includes(resourceType)) {
          matchedTriggers.push(`resourceType:${rt}`);
          break;
        }
      }
    }

    // Check pattern match
    for (const pattern of triggers.patterns) {
      const patternLower = pattern.toLowerCase();
      if (detectedPatterns.some((p) => p.toLowerCase() === patternLower)) {
        matchedTriggers.push(`pattern:${pattern}`);
      }
    }

    // Check metric match
    for (const metric of triggers.metrics) {
      const metricLower = metric.toLowerCase();
      if (anomalousMetrics.some((m) => m.toLowerCase().includes(metricLower) || metricLower.includes(m.toLowerCase()))) {
        matchedTriggers.push(`metric:${metric}`);
      }
    }

    // Check symptom match (fuzzy: check if user symptom text contains trigger keyword)
    for (const symptom of triggers.symptoms) {
      const symptomLower = symptom.toLowerCase();
      const matched =
        symptoms.some((s) => s.toLowerCase().includes(symptomLower)) ||
        descriptionText.includes(symptomLower);
      if (matched) {
        matchedTriggers.push(`symptom:${symptom}`);
      }
    }

    if (matchedTriggers.length > 0) {
      let relevance: "high" | "medium" | "low";
      if (matchedTriggers.length >= 3) {
        relevance = "high";
      } else if (matchedTriggers.length === 2) {
        relevance = "medium";
      } else {
        relevance = "low";
      }

      results.push({
        name: playbook.frontmatter.name,
        description: playbook.frontmatter.description,
        relevance,
        matchedTriggers,
        content: playbook.raw,
      });
    }
  }

  // Sort by relevance (high first)
  const relevanceOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  results.sort(
    (a, b) => (relevanceOrder[a.relevance] ?? 2) - (relevanceOrder[b.relevance] ?? 2)
  );

  return results;
}

/**
 * Extract an array of strings from the context object, trying multiple key names.
 * Also handles the case where values are nested inside objects (e.g., pattern objects with a "pattern" field).
 */
function extractStringArray(context: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = context[key];
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null) {
          // Handle objects like { pattern: "memory_exhaustion", ... }
          const obj = item as Record<string, unknown>;
          return String(obj["pattern"] ?? obj["name"] ?? obj["metric"] ?? obj["metricName"] ?? "");
        }
        return String(item);
      }).filter((s) => s !== "");
    }
    if (typeof value === "string" && value.trim() !== "") {
      return [value];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

export function registerPlaybooks(server: McpServer): void {
  server.tool(
    "azdoctor_playbooks",
    "Manage custom diagnostic playbooks. Users can create playbooks in ~/.azdoctor/playbooks/ to define custom diagnostic patterns and remediation steps. Use 'list' to see available playbooks, 'show' to view one, or 'match' to find playbooks relevant to an investigation.",
    {
      action: z
        .enum(["list", "show", "match", "init"])
        .describe(
          "Action: list available playbooks, show a specific one, match against investigation findings, or init to create a sample playbook"
        ),
      playbookName: z
        .string()
        .optional()
        .describe("Playbook name (required for 'show' action)"),
      investigationContext: z
        .string()
        .optional()
        .describe(
          "JSON output from azdoctor_investigate — used by 'match' action to find relevant playbooks"
        ),
    },
    async ({ action, playbookName, investigationContext }) => {
      try {
        switch (action) {
          case "list": {
            const playbooks = loadPlaybooks();
            const listing = playbooks.map((p) => ({
              name: p.frontmatter.name,
              fileName: p.fileName,
              description: p.frontmatter.description,
              resourceTypes: p.frontmatter.triggers.resourceTypes,
              triggers: [
                ...p.frontmatter.triggers.patterns,
                ...p.frontmatter.triggers.symptoms,
              ],
              severity: p.frontmatter.severity,
            }));

            const result = {
              playbooksDir: PLAYBOOKS_DIR,
              playbooks: listing,
              totalPlaybooks: listing.length,
            };

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case "show": {
            if (!playbookName) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      error:
                        "playbookName is required for the 'show' action.",
                    }),
                  },
                ],
                isError: true,
              };
            }

            const playbooks = loadPlaybooks();
            const nameLower = playbookName.toLowerCase();
            const found = playbooks.find(
              (p) =>
                p.frontmatter.name.toLowerCase() === nameLower ||
                p.fileName.replace(/\.md$/, "").toLowerCase() === nameLower
            );

            if (!found) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      error: `Playbook not found: "${playbookName}". Use the 'list' action to see available playbooks.`,
                      availablePlaybooks: playbooks.map(
                        (p) => p.frontmatter.name
                      ),
                    }),
                  },
                ],
                isError: true,
              };
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: found.raw,
                },
              ],
            };
          }

          case "match": {
            if (!investigationContext) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      error:
                        "investigationContext is required for the 'match' action. Pass the JSON output from azdoctor_investigate.",
                    }),
                  },
                ],
                isError: true,
              };
            }

            let context: Record<string, unknown>;
            try {
              context = JSON.parse(investigationContext) as Record<string, unknown>;
            } catch {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      error:
                        "Failed to parse investigationContext as JSON. Ensure it is valid JSON from azdoctor_investigate.",
                    }),
                  },
                ],
                isError: true,
              };
            }

            const playbooks = loadPlaybooks();
            if (playbooks.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      matchedPlaybooks: [],
                      totalMatched: 0,
                      investigatedResource: String(
                        context["resource"] ?? context["resourceId"] ?? "unknown"
                      ),
                      hint: `No playbooks found in ${PLAYBOOKS_DIR}. Run the 'init' action to create sample playbooks.`,
                    }),
                  },
                ],
              };
            }

            const matched = matchPlaybooks(playbooks, context);
            const investigatedResource = String(
              context["resource"] ?? context["resourceId"] ?? "unknown"
            );

            const result = {
              matchedPlaybooks: matched,
              totalMatched: matched.length,
              investigatedResource,
            };

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case "init": {
            mkdirSync(PLAYBOOKS_DIR, { recursive: true });

            const sampleFiles: string[] = [];

            const highMemoryPath = join(
              PLAYBOOKS_DIR,
              "example-high-memory.md"
            );
            if (!existsSync(highMemoryPath)) {
              writeFileSync(highMemoryPath, SAMPLE_HIGH_MEMORY.trimStart(), "utf-8");
              sampleFiles.push("example-high-memory.md");
            }

            const connFailuresPath = join(
              PLAYBOOKS_DIR,
              "example-connection-failures.md"
            );
            if (!existsSync(connFailuresPath)) {
              writeFileSync(
                connFailuresPath,
                SAMPLE_CONNECTION_FAILURES.trimStart(),
                "utf-8"
              );
              sampleFiles.push("example-connection-failures.md");
            }

            const result = {
              initialized: true,
              playbooksDir: PLAYBOOKS_DIR,
              samplePlaybooksCreated: sampleFiles,
            };

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          default: {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: `Unknown action: ${action}`,
                  }),
                },
              ],
              isError: true,
            };
          }
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
