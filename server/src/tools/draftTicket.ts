import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveSubscription } from "../utils/azure-client.js";

export function registerDraftTicket(server: McpServer): void {
  server.tool(
    "azdoctor_draft_ticket",
    "Pre-populate a support ticket with diagnostic context from a prior investigation. Creates via Support API if accessible, otherwise generates a formatted draft for copy-paste.",
    {
      resource: z.string().describe("Resource name or full Azure resource ID"),
      subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
      investigationSummary: z
        .string()
        .describe("Output from azdoctor_investigate to include as context"),
      severity: z
        .enum(["A", "B", "C"])
        .optional()
        .describe("Support ticket severity (A = critical, B = moderate, C = minimal)"),
    },
    async ({ resource, subscription: subParam, investigationSummary, severity }) => {
      const subscription = await resolveSubscription(subParam);
      // TODO: Implement ticket drafting
      // 1. Check Support API access (requires Support Request Contributor + paid plan)
      // 2. If accessible: create ticket via REST API with diagnostic context
      // 3. If not accessible: generate formatted draft for copy-paste

      const stubResponse = {
        ticketDraft: {
          title: `Diagnostic Investigation: ${resource}`,
          severity: severity ?? "C",
          subscription,
          resource,
          description: investigationSummary,
          diagnosticContext:
            "Full diagnostic context would be attached here.",
        },
        supportApiAccessible: false,
        message:
          "Ticket drafting not yet implemented — this is a stub response. Copy the draft above into Azure Portal > Help + Support.",
        _stub: true,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(stubResponse, null, 2),
          },
        ],
      };
    }
  );
}
