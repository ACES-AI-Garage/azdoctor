import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerHealthcheck } from "./tools/healthcheck.js";
import { registerInvestigate } from "./tools/investigate.js";
import { registerRca } from "./tools/rca.js";
import { registerCheckPermissions } from "./tools/checkPermissions.js";
import { registerDraftTicket } from "./tools/draftTicket.js";
const server = new McpServer({
    name: "azdoctor",
    version: "0.1.0",
});
// Register all diagnostic tools
registerHealthcheck(server);
registerInvestigate(server);
registerRca(server);
registerCheckPermissions(server);
registerDraftTicket(server);
// Connect via STDIO transport (Copilot CLI spawns this process)
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error("AZ Doctor MCP server failed to start:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map