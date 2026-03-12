import { z } from "zod";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const JOURNAL_DIR = join(homedir(), ".azdoctor", "journal");
function ensureJournalDir() {
    mkdirSync(JOURNAL_DIR, { recursive: true });
}
function formatDate(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function sanitizeResourceName(resource) {
    // Remove or replace characters that are unsafe in filenames
    return resource
        .replace(/[/\\:*?"<>|]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase();
}
export function registerJournal(server) {
    server.tool("azdoctor_journal", "Persist investigation results as local markdown files. Builds an incident history for reference. Use 'save' to record an investigation, 'list' to see past entries, 'read' to view a specific entry.", {
        action: z
            .enum(["save", "list", "read"])
            .describe("Action to perform"),
        resource: z
            .string()
            .optional()
            .describe("Resource name (required for save, optional filter for list)"),
        content: z
            .string()
            .optional()
            .describe("Investigation output to save (required for save action)"),
        entryId: z
            .string()
            .optional()
            .describe("Entry ID to read (required for read action, returned by list)"),
    }, async ({ action, resource, content, entryId }) => {
        // ── save ──────────────────────────────────────────────────────
        if (action === "save") {
            if (!resource) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: "The 'resource' parameter is required for the save action." }, null, 2),
                        },
                    ],
                };
            }
            if (!content) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: "The 'content' parameter is required for the save action." }, null, 2),
                        },
                    ],
                };
            }
            ensureJournalDir();
            const now = new Date();
            const safeName = sanitizeResourceName(resource);
            const dateStr = formatDate(now);
            const filename = `${safeName}-${dateStr}.md`;
            const filepath = join(JOURNAL_DIR, filename);
            const entryIdValue = filename.replace(/\.md$/, "");
            const markdown = `# Investigation: ${resource}
**Date:** ${now.toISOString()}
**Resource:** ${resource}

## Diagnostic Output
${content}

---
*Saved by AZ Doctor*
`;
            writeFileSync(filepath, markdown, "utf-8");
            const response = {
                saved: true,
                path: filepath,
                entryId: entryIdValue,
            };
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response, null, 2),
                    },
                ],
            };
        }
        // ── list ──────────────────────────────────────────────────────
        if (action === "list") {
            ensureJournalDir();
            let files;
            try {
                files = readdirSync(JOURNAL_DIR).filter((f) => f.endsWith(".md"));
            }
            catch {
                files = [];
            }
            // Optionally filter by resource name
            if (resource) {
                const safeResource = sanitizeResourceName(resource);
                files = files.filter((f) => f.toLowerCase().startsWith(safeResource));
            }
            // Parse entries and extract metadata
            const entries = files
                .map((f) => {
                const entryIdValue = f.replace(/\.md$/, "");
                const filepath = join(JOURNAL_DIR, f);
                // Try to extract resource and date from the file
                let entryResource = "unknown";
                let entryDate = "";
                try {
                    const fileContent = readFileSync(filepath, "utf-8");
                    const lines = fileContent.split(/\r?\n/);
                    for (const line of lines) {
                        const resourceMatch = line.match(/^\*\*Resource:\*\*\s*(.+)$/);
                        if (resourceMatch) {
                            entryResource = resourceMatch[1].trim();
                        }
                        const dateMatch = line.match(/^\*\*Date:\*\*\s*(.+)$/);
                        if (dateMatch) {
                            entryDate = dateMatch[1].trim();
                        }
                    }
                }
                catch {
                    // If we can't read the file, use what we can from the filename
                }
                return {
                    entryId: entryIdValue,
                    resource: entryResource,
                    date: entryDate,
                    path: filepath,
                };
            })
                .sort((a, b) => b.date.localeCompare(a.date));
            const response = {
                entries,
                totalEntries: entries.length,
            };
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response, null, 2),
                    },
                ],
            };
        }
        // ── read ──────────────────────────────────────────────────────
        if (action === "read") {
            if (!entryId) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: "The 'entryId' parameter is required for the read action." }, null, 2),
                        },
                    ],
                };
            }
            ensureJournalDir();
            const filename = entryId.endsWith(".md") ? entryId : `${entryId}.md`;
            const filepath = join(JOURNAL_DIR, filename);
            if (!existsSync(filepath)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                error: `Entry '${entryId}' not found. Use the 'list' action to see available entries.`,
                            }, null, 2),
                        },
                    ],
                };
            }
            const fileContent = readFileSync(filepath, "utf-8");
            const response = {
                entryId,
                content: fileContent,
            };
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response, null, 2),
                    },
                ],
            };
        }
        // Should not reach here due to zod enum validation
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: `Unknown action: ${action}` }, null, 2),
                },
            ],
        };
    });
}
//# sourceMappingURL=journal.js.map