import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerHealthcheck } from "./tools/healthcheck.js";
import { registerInvestigate } from "./tools/investigate.js";
import { registerBaseline } from "./tools/baseline.js";
import { registerCompare } from "./tools/compare.js";
import { registerRemediate } from "./tools/remediate.js";
import { registerAlertRules } from "./tools/alertRules.js";
import { registerRbacAudit } from "./tools/rbacAudit.js";

const server = new McpServer({
  name: "azdoctor",
  version: "0.2.0",
});

registerHealthcheck(server);
registerInvestigate(server);
registerBaseline(server);
registerCompare(server);
registerRemediate(server);
registerAlertRules(server);
registerRbacAudit(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("AZ Doctor MCP server failed to start:", error);
  process.exit(1);
});
