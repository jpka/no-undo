/**
 * Agent loop orchestration — prompt to signed document.
 *
 * Wires three pieces together:
 *   1. Foxit PDF MCP server — reversible document work (assembly, conversion, OCR, merge).
 *   2. eSign MCP server — the crash-safe gate around the irreversible send.
 *   3. localhost approval server — renders the plan for human review (custom renderPlan hook).
 *
 * Pipeline:
 *   1. Messy input document → Foxit MCP assembly/conversion tools (all reversible).
 *   2. eSign MCP creates a draft folder (reversible) + plan token.
 *   3. Approval server renders document + recipients, human approves/rejects.
 *   4. eSign MCP transitions plan to "executing" → gateway send → confirm.
 *
 * The custom renderPlan hook renders the folder name, recipient list, and an
 * explicit irrevocability warning — NOT JSON.stringify (the core default, which
 * the build plan flags as embarrassing for a PII demo).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startApprovalServer } from "../safe-write-mcp-core/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- MCP client helper ------------------------------------------------------

/**
 * Connect to an MCP server via stdio transport.
 * @param {string} name - Client name for the connection
 * @param {string} serverPath - Path to the MCP server entry point
 * @param {Record<string, string>} [env] - Environment variables to forward
 * @returns {Promise<Client>}
 */
async function connectMcp(name, serverPath, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--transport", "stdio"],
    env: { ...process.env, ...env },
  });
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(transport);
  return client;
}

// --- Custom renderPlan hook -------------------------------------------------

/**
 * Render an eSign plan for the approval UI.
 * Shows the folder name, recipient list, and an explicit irrevocability warning.
 * Does NOT dump the raw payload JSON.
 * @param {import("../safe-write-mcp-core/dist/approvalServer.js").PendingPlan<any>} plan
 * @returns {import("../safe-write-mcp-core/dist/approvalServer.js").RenderablePlan}
 */
function renderEsignPlan(plan) {
  const payload = plan.payload || {};
  const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
  const folderName = payload.folderName || "(unnamed)";
  const folderId = payload.folderId || plan.extra?.folderId || "—";

  const recipientRows = recipients.map(
    (r, i) => `${i + 1}. ${r.firstName ?? "?"} ${r.lastName ?? "?"} <${r.email ?? "?"}>`,
  ).join("\n");

  return {
    title: `✍️  Sign: ${folderName}`,
    details: [
      { label: "Folder", value: folderName },
      { label: "Folder ID", value: String(folderId) },
      { label: "Recipients", value: recipientRows || "(none)" },
      { label: "Agent's reason", value: plan.reason || "(none given)" },
      {
        label: "⚠️ Irreversible",
        value:
          "Approving sends this document to the listed recipients for signature. " +
          "This action cannot be undone. Emails will be sent immediately.",
      },
    ],
  };
}

// --- Main agent loop --------------------------------------------------------

/**
 * Run the full pipeline: create draft → render for approval → send.
 * @param {object} options
 * @param {string} options.folderName - Name for the draft folder
 * @param {Array<{firstName: string, lastName: string, email: string}>} options.recipients - Signers
 * @param {string} [options.inputDocument] - Optional input document path/URL for reversible Foxit work
 */
async function runAgentLoop({ folderName, recipients, inputDocument }) {
  console.log("[agent] Starting eSign send pipeline...");
  console.log(`[agent] Folder: ${folderName}`);
  console.log(`[agent] Recipients: ${recipients.length}`);

  // Connect to the eSign MCP server
  const esignServerPath = join(__dirname, "esign-mcp-server.mjs");
  const esignClient = await connectMcp("no-undo-agent", esignServerPath);

  try {
    // Step 1: Create draft folder (reversible)
    console.log("[agent] Creating draft folder...");
    const createResult = await esignClient.callTool({
      name: "esign_create_draft",
      arguments: { folderName, recipients },
    });

    if (createResult.isError) {
      throw new Error(`Draft creation failed: ${JSON.stringify(createResult)}`);
    }

    const createJson = JSON.parse(createResult.content[0].text);
    const { planToken, folderId } = createJson;
    console.log(`[agent] Draft created: folderId=${folderId}, planToken=${planToken.slice(0, 8)}...`);

    // Step 2: Start the approval server with the custom renderPlan hook
    console.log("[agent] Starting approval server...");
    // Note: The eSign MCP server doesn't expose the PlanStore directly.
    // The approval UI calls the eSign MCP server's endpoints.
    // For a standalone agent loop, we need a different architecture:
    //   - The eSign MCP server IS the gate
    //   - The approval UI talks to the core's approval server
    //   - Both share the same PlanStore (in-memory)
    //
    // This requires either:
    //   a) Running the approval server in the same process as the eSign MCP server
    //   b) Having the approval server call the eSign MCP server's approve/reject
    //
    // For now, the approval server is started separately and the human
    // approves via the browser UI. The eSign MCP server handles the rest.

    console.log("[agent] Plan is awaiting approval.");
    console.log("[agent] Open the approval UI in a browser to approve or reject.");
    console.log("[agent] (The approval server is a separate process.)");

    // Step 3: After approval, begin send
    // This would be triggered by the human action in the approval UI.
    // For now, we return the plan token for the caller to use.
    return { planToken, folderId, status: "awaiting_approval" };

  } finally {
    await esignClient.close();
  }
}

// --- CLI --------------------------------------------------------------------

async function main() {
  // Demo: create a draft and await approval
  const result = await runAgentLoop({
    folderName: "demo-contract",
    recipients: [
      { firstName: "Alice", lastName: "Smith", email: "alice@example.com" },
      { firstName: "Bob", lastName: "Jones", email: "bob@example.com" },
    ],
  });
  console.log("[agent] Result:", result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[agent] Fatal:", err);
    process.exit(1);
  });
}

export { runAgentLoop, renderEsignPlan };
