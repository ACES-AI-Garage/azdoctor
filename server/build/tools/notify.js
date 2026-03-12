import { z } from "zod";
function detectWebhookType(url) {
    if (url.includes("webhook.office.com") || url.includes("microsoft.com"))
        return "teams";
    if (url.includes("hooks.slack.com"))
        return "slack";
    return "generic";
}
function formatTeamsMessage(title, message, severity) {
    return {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        themeColor: severity === "critical" ? "FF0000" : severity === "warning" ? "FFA500" : "00FF00",
        summary: title,
        sections: [
            {
                activityTitle: title,
                activitySubtitle: `Severity: ${severity.toUpperCase()} | ${new Date().toISOString()}`,
                text: message.length > 2000 ? message.substring(0, 2000) + "\n\n... (truncated)" : message,
                markdown: true,
            },
        ],
    };
}
function formatSlackMessage(title, message, severity) {
    const emoji = severity === "critical" ? "\uD83D\uDD34" : severity === "warning" ? "\uD83D\uDFE1" : "\uD83D\uDFE2";
    return {
        blocks: [
            {
                type: "header",
                text: { type: "plain_text", text: `${emoji} ${title}` },
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: message.length > 3000 ? message.substring(0, 3000) + "\n\n... (truncated)" : message,
                },
            },
            {
                type: "context",
                elements: [
                    {
                        type: "mrkdwn",
                        text: `*Severity:* ${severity.toUpperCase()} | *Sent:* ${new Date().toISOString()} | _via AZ Doctor_`,
                    },
                ],
            },
        ],
    };
}
function formatGenericMessage(title, message, severity) {
    return {
        title,
        severity,
        message,
        timestamp: new Date().toISOString(),
        source: "azdoctor",
    };
}
async function sendWebhook(url, payload) {
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            return { success: false, statusCode: response.status, error: `HTTP ${response.status}: ${text}` };
        }
        return { success: true, statusCode: response.status };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, statusCode: 0, error: message };
    }
}
function summarizeToolOutput(message) {
    try {
        const parsed = JSON.parse(message);
        const parts = [];
        if (parsed.resource)
            parts.push(`**Resource:** ${parsed.resource}`);
        if (parsed.currentHealth)
            parts.push(`**Health:** ${parsed.currentHealth}`);
        if (parsed.confidence)
            parts.push(`**Confidence:** ${parsed.confidence}`);
        if (parsed.likelyCause)
            parts.push(`**Likely Cause:** ${parsed.likelyCause}`);
        if (parsed.riskScore !== undefined)
            parts.push(`**Risk Score:** ${parsed.riskScore}/100`);
        if (parsed.diagnosticCoverage)
            parts.push(`**Coverage:** ${parsed.diagnosticCoverage}`);
        if (parsed.diagnosticInsights?.length > 0) {
            parts.push(`**Patterns Detected:** ${parsed.diagnosticInsights.map((i) => i.pattern).join(", ")}`);
        }
        if (parsed.recommendedActions?.length > 0) {
            parts.push(`**Next Steps:**`);
            for (const action of parsed.recommendedActions.slice(0, 3)) {
                parts.push(`- ${action}`);
            }
        }
        if (parts.length > 0)
            return parts.join("\n");
    }
    catch {
        // Not JSON, use as-is
    }
    return message;
}
export function registerNotify(server) {
    server.tool("azdoctor_notify", "Send investigation summaries or alerts to Teams, Slack, or any webhook endpoint. Useful for on-call handoffs and incident communication.", {
        webhookUrl: z.string().describe("Webhook URL (Teams Incoming Webhook, Slack Incoming Webhook, or any HTTP endpoint)"),
        message: z.string().describe("Message content or JSON output from an AZ Doctor tool to format and send"),
        title: z.string().optional().describe("Message title/subject (default: 'AZ Doctor Alert')"),
        severity: z.enum(["critical", "warning", "info"]).default("info").describe("Severity level — affects message color/formatting"),
        format: z.enum(["auto", "teams", "slack", "generic"]).default("auto").describe("Message format. Auto-detects from webhook URL."),
    }, async ({ webhookUrl, message, title, severity, format }) => {
        const resolvedTitle = title ?? "AZ Doctor Alert";
        const webhookType = format === "auto" ? detectWebhookType(webhookUrl) : format;
        const formattedMessage = summarizeToolOutput(message);
        let payload;
        switch (webhookType) {
            case "teams":
                payload = formatTeamsMessage(resolvedTitle, formattedMessage, severity);
                break;
            case "slack":
                payload = formatSlackMessage(resolvedTitle, formattedMessage, severity);
                break;
            default:
                payload = formatGenericMessage(resolvedTitle, formattedMessage, severity);
                break;
        }
        const result = await sendWebhook(webhookUrl, payload);
        const messageSummary = formattedMessage.substring(0, 100) + (formattedMessage.length > 100 ? "..." : "");
        const response = {
            sent: result.success,
            webhookType,
            statusCode: result.statusCode,
            ...(result.error && { error: result.error }),
            messageSummary,
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
//# sourceMappingURL=notify.js.map