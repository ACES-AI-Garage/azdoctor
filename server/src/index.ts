import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerHealthcheck } from "./tools/healthcheck.js";
import { registerInvestigate } from "./tools/investigate.js";
import { registerRca } from "./tools/rca.js";
import { registerCheckPermissions } from "./tools/checkPermissions.js";
import { registerCompare } from "./tools/compare.js";
import { registerRemediate } from "./tools/remediate.js";
import { registerQueryTool } from "./tools/query.js";
import { registerCost } from "./tools/cost.js";
import { registerPlayback } from "./tools/playback.js";
import { registerAlertRules } from "./tools/alertRules.js";
import { registerSweep } from "./tools/sweep.js";
import { registerBaseline } from "./tools/baseline.js";
import { registerJournal } from "./tools/journal.js";
import { registerPlaybooks } from "./tools/playbooks.js";
import { registerTriage } from "./tools/triage.js";
import { registerDiagram } from "./tools/diagram.js";
import { registerAdvisor } from "./tools/advisor.js";
import { registerNotify } from "./tools/notify.js";

const server = new McpServer({
  name: "azdoctor",
  version: "0.1.0",
});

// Register diagnostic tools
registerHealthcheck(server);
registerInvestigate(server);
registerRca(server);
registerCheckPermissions(server);
registerCompare(server);
registerRemediate(server);
registerQueryTool(server);
registerCost(server);
registerPlayback(server);
registerAlertRules(server);
registerSweep(server);
registerBaseline(server);
registerJournal(server);
registerPlaybooks(server);
registerTriage(server);
registerDiagram(server);
registerAdvisor(server);
registerNotify(server);

// Connect via STDIO transport (Copilot CLI spawns this process)
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("AZ Doctor MCP server failed to start:", error);
  process.exit(1);
});
