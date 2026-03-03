import { z } from "zod";
import { resolveSubscription } from "../utils/azure-client.js";
export function registerCheckPermissions(server) {
    server.tool("azdoctor_check_permissions", "Detect what diagnostic data the current credentials can access and recommend role upgrades for fuller diagnostics.", {
        subscription: z.string().optional().describe("Azure subscription ID (auto-detected from az CLI if omitted)"),
    }, async ({ subscription: subParam }) => {
        const subscription = await resolveSubscription(subParam);
        // TODO: Implement permission checks
        // 1. Try Resource Health API → catch 403
        // 2. Try Activity Log API → catch 403
        // 3. Try Log Analytics query → catch 403
        // 4. Try Resource Graph → catch 403
        // 5. Check Support API access
        // 6. Return matrix of access + role recommendations
        const stubResponse = {
            subscription,
            checks: {
                resourceHealth: { accessible: false, status: "not_checked" },
                activityLog: { accessible: false, status: "not_checked" },
                logAnalytics: { accessible: false, status: "not_checked" },
                resourceGraph: { accessible: false, status: "not_checked" },
                supportApi: { accessible: false, status: "not_checked" },
            },
            recommendations: [
                "Permission checking not yet implemented — this is a stub response",
            ],
            _stub: true,
        };
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(stubResponse, null, 2),
                },
            ],
        };
    });
}
//# sourceMappingURL=checkPermissions.js.map