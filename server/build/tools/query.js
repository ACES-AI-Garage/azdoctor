import { z } from "zod";
import { resolveSubscription, discoverWorkspaces, queryLogAnalytics, } from "../utils/azure-client.js";
const QUERY_TEMPLATES = [
    {
        patterns: [/failed\s+requests?/i, /error\s+requests?/i, /5\d{2}\s+errors?/i, /http\s+errors?/i],
        table: "AppRequests",
        label: "failed requests",
        buildQuery: (_match, hours, maxRows) => `AppRequests
| where TimeGenerated > ago(${hours}h)
| where Success == false
| summarize FailedCount = count() by bin(TimeGenerated, 1h), OperationName, ResultCode
| order by FailedCount desc
| take ${maxRows}`,
        suggestions: [
            "Try 'slow requests' to check for latency issues",
            "Try 'exceptions' to see related application errors",
            "Try 'dependency failures' to check if a backend service is causing the errors",
        ],
    },
    {
        patterns: [/exceptions?/i, /crashes?/i, /unhandled/i, /stack\s*traces?/i],
        table: "AppExceptions",
        label: "exceptions",
        buildQuery: (_match, hours, maxRows) => `AppExceptions
| where TimeGenerated > ago(${hours}h)
| summarize ExceptionCount = count() by ExceptionType, OuterMessage, bin(TimeGenerated, 1h)
| order by ExceptionCount desc
| take ${maxRows}`,
        suggestions: [
            "Try 'failed requests' to see which HTTP requests are affected",
            "Try 'dependency failures' to check if exceptions are caused by downstream services",
        ],
    },
    {
        patterns: [/slow\s+requests?/i, /latency/i, /response\s+time/i, /performance/i],
        table: "AppRequests",
        label: "slow requests / latency",
        buildQuery: (_match, hours, maxRows) => `AppRequests
| where TimeGenerated > ago(${hours}h)
| where DurationMs > 1000
| summarize AvgDuration = avg(DurationMs), P95Duration = percentile(DurationMs, 95), Count = count() by OperationName, bin(TimeGenerated, 1h)
| order by P95Duration desc
| take ${maxRows}`,
        suggestions: [
            "Try 'dependency failures' to check if slow backends are causing latency",
            "Try 'cpu memory' to check resource utilization",
            "Try 'failed requests' to see if latency is leading to failures",
        ],
    },
    {
        patterns: [/dependency\s+failures?/i, /external\s+calls?/i, /backend\s+errors?/i, /downstream/i],
        table: "AppDependencies",
        label: "dependency failures",
        buildQuery: (_match, hours, maxRows) => `AppDependencies
| where TimeGenerated > ago(${hours}h)
| where Success == false
| summarize FailedCount = count() by DependencyType, Target, ResultCode, bin(TimeGenerated, 1h)
| order by FailedCount desc
| take ${maxRows}`,
        suggestions: [
            "Try 'failed requests' to see the impact on incoming requests",
            "Try 'exceptions' to see application-level errors from dependency failures",
        ],
    },
    {
        patterns: [/sign.?in/i, /login/i, /auth/i, /access\s+denied/i, /unauthorized/i, /401/i, /403/i],
        table: "SigninLogs",
        label: "sign-in / auth failures",
        buildQuery: (_match, hours, maxRows) => `SigninLogs
| where TimeGenerated > ago(${hours}h)
| where ResultType != "0"
| summarize FailureCount = count() by ResultType, ResultDescription, UserPrincipalName, AppDisplayName
| order by FailureCount desc
| take ${maxRows}`,
        suggestions: [
            "Try 'azure activity audit' to see related resource-level changes",
            "Try 'security alerts' to check for suspicious sign-in activity",
        ],
    },
    {
        patterns: [/azure\s+activity/i, /resource\s+changes?/i, /deployments?/i, /who\s+changed/i, /audit/i],
        table: "AzureActivity",
        label: "Azure activity / audit",
        buildQuery: (_match, hours, maxRows) => `AzureActivity
| where TimeGenerated > ago(${hours}h)
| where ActivityStatusValue == "Failure" or Level == "Error"
| summarize Count = count() by OperationNameValue, ActivityStatusValue, Caller, bin(TimeGenerated, 1h)
| order by Count desc
| take ${maxRows}`,
        suggestions: [
            "Try 'failed requests' to see if deployment changes caused application errors",
            "Try 'security alerts' to check for unauthorized activity",
        ],
    },
    {
        patterns: [/memory/i, /cpu/i, /resource\s+usage/i, /utilization/i],
        table: "Perf",
        label: "CPU / memory utilization",
        buildQuery: (_match, hours, maxRows) => `Perf
| where TimeGenerated > ago(${hours}h)
| where ObjectName == "Processor" or ObjectName == "Memory"
| summarize AvgValue = avg(CounterValue), MaxValue = max(CounterValue) by Computer, CounterName, bin(TimeGenerated, 1h)
| order by AvgValue desc
| take ${maxRows}`,
        suggestions: [
            "Try 'slow requests' to check if high resource usage is causing latency",
            "Try 'container pod errors' if running in Kubernetes",
        ],
    },
    {
        patterns: [/threat/i, /security\s+alert/i, /attack/i, /malicious/i, /suspicious/i],
        table: "SecurityAlert",
        label: "security alerts",
        buildQuery: (_match, hours, maxRows) => `SecurityAlert
| where TimeGenerated > ago(${hours}h)
| summarize AlertCount = count() by AlertName, AlertSeverity, ProviderName
| order by AlertCount desc
| take ${maxRows}`,
        suggestions: [
            "Try 'sign-in failures' to check for compromised accounts",
            "Try 'azure activity audit' to see related resource changes",
        ],
    },
    {
        patterns: [/container/i, /pod/i, /kubernetes/i, /k8s/i, /aks/i],
        table: "ContainerLogV2",
        label: "container / Kubernetes errors",
        buildQuery: (_match, hours, maxRows) => `ContainerLogV2
| where TimeGenerated > ago(${hours}h)
| where LogLevel in ("error", "critical", "fatal")
| summarize ErrorCount = count() by ContainerName, PodName, LogLevel, bin(TimeGenerated, 1h)
| order by ErrorCount desc
| take ${maxRows}`,
        suggestions: [
            "Try 'cpu memory' to check node resource utilization",
            "Try 'failed requests' to see the impact on incoming traffic",
        ],
    },
];
// ─── KQL Detection ──────────────────────────────────────────────────
const KQL_KEYWORDS = /\b(where|summarize|project|extend|join|union|parse|render|make-series|mv-expand|evaluate)\b/i;
function isRawKql(description) {
    // If it contains a pipe and a KQL keyword, treat as raw KQL
    return description.includes("|") && KQL_KEYWORDS.test(description);
}
// ─── Template Matching ──────────────────────────────────────────────
function matchTemplate(description, timeframeHours, maxRows) {
    for (const template of QUERY_TEMPLATES) {
        for (const pattern of template.patterns) {
            const match = description.match(pattern);
            if (match) {
                return {
                    kql: template.buildQuery(match, timeframeHours, maxRows),
                    matchedPattern: template.label,
                    suggestions: template.suggestions,
                };
            }
        }
    }
    return null;
}
function buildFallbackQuery(description, timeframeHours, maxRows) {
    // Escape any single quotes in the description for use inside KQL search
    const escaped = description.replace(/'/g, "\\'");
    return `union App*, Azure*, Syslog, SecurityEvent
| where TimeGenerated > ago(${timeframeHours}h)
| search "${escaped}"
| take ${maxRows}`;
}
// ─── Tool Registration ──────────────────────────────────────────────
export function registerQueryTool(server) {
    server.tool("azdoctor_query", "Generate and execute KQL queries against Log Analytics workspaces. Accepts natural language descriptions or raw KQL. Auto-discovers workspaces in the target resource group.", {
        description: z
            .string()
            .describe("Natural language description of what to query (e.g., 'failed requests for prod-api in the last hour') or raw KQL query"),
        subscription: z
            .string()
            .optional()
            .describe("Azure subscription ID (auto-detected if omitted)"),
        resourceGroup: z
            .string()
            .optional()
            .describe("Resource group containing the Log Analytics workspace"),
        workspaceId: z
            .string()
            .optional()
            .describe("Specific Log Analytics workspace ID (auto-discovered if omitted)"),
        timeframeHours: z
            .number()
            .default(24)
            .describe("How many hours back to query"),
        maxRows: z
            .number()
            .default(50)
            .describe("Maximum rows to return"),
    }, async ({ description, subscription, resourceGroup, workspaceId, timeframeHours, maxRows, }) => {
        // ── Step 1: Resolve workspace ──────────────────────────────────
        let resolvedWorkspaceId = workspaceId;
        let workspaceName;
        if (!resolvedWorkspaceId) {
            if (!resourceGroup) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                error: {
                                    code: "MISSING_PARAMETER",
                                    message: "Either 'workspaceId' or 'resourceGroup' must be provided so a Log Analytics workspace can be resolved.",
                                },
                            }, null, 2),
                        },
                    ],
                };
            }
            const subscriptionId = await resolveSubscription(subscription);
            const discovery = await discoverWorkspaces(subscriptionId, resourceGroup);
            if (discovery.error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: discovery.error }, null, 2),
                        },
                    ],
                };
            }
            if (discovery.workspaces.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                error: {
                                    code: "NO_WORKSPACE",
                                    message: `No Log Analytics workspaces found in resource group '${resourceGroup}'. Provide a specific workspaceId or check the resource group name.`,
                                },
                            }, null, 2),
                        },
                    ],
                };
            }
            // Use the first discovered workspace
            resolvedWorkspaceId = discovery.workspaces[0].workspaceId;
            workspaceName = discovery.workspaces[0].workspaceName;
        }
        // ── Step 2: Determine query type and build KQL ─────────────────
        let kql;
        let queryType;
        let matchedPattern;
        let suggestions;
        if (isRawKql(description)) {
            kql = description;
            queryType = "raw";
        }
        else {
            const templateResult = matchTemplate(description, timeframeHours, maxRows);
            if (templateResult) {
                kql = templateResult.kql;
                queryType = "generated";
                matchedPattern = templateResult.matchedPattern;
                suggestions = templateResult.suggestions;
            }
            else {
                kql = buildFallbackQuery(description, timeframeHours, maxRows);
                queryType = "generated";
                matchedPattern = "fallback (free-text search)";
                suggestions = [
                    "Try more specific queries like 'failed requests', 'exceptions', 'slow requests', 'dependency failures', 'sign-in failures', 'cpu memory', 'security alerts', 'container pod errors', or 'azure activity audit'.",
                ];
            }
        }
        // ── Step 3: Execute the query ──────────────────────────────────
        const queryResult = await queryLogAnalytics(resolvedWorkspaceId, kql, timeframeHours);
        // ── Step 4: Format the response ────────────────────────────────
        const firstTable = queryResult.tables[0];
        const response = {
            workspaceId: resolvedWorkspaceId,
            ...(workspaceName ? { workspaceName } : {}),
            queryType,
            kql,
            ...(matchedPattern ? { matchedPattern } : {}),
            timeframeHours,
            results: {
                columns: firstTable?.columns ?? [],
                rows: firstTable?.rows ?? [],
                rowCount: firstTable?.rows.length ?? 0,
            },
            ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
            ...(queryResult.error ? { error: queryResult.error } : {}),
        };
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(response, null, 2),
                },
            ],
        };
    });
}
//# sourceMappingURL=query.js.map