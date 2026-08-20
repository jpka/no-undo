/**
 * Foxit eSign MCP server — exposes the eSign adapter lifecycle as MCP tools
 * AND runs the localhost approval server in-process.
 *
 * Tools:
 *   - esign_create_draft: create a draft folder (reversible) + plan token
 *   - esign_begin_send: transition plan to "executing" (the gate)
 *   - esign_confirm_executed: mark plan used after gateway send succeeds
 *   - esign_confirm_failed: release plan back to retryable after send fails
 *   - esign_list_executing: list plans stuck mid-execute (health check)
 *   - esign_reconcile: reconcile a stuck plan against gateway folderStatus
 *
 * The approval gate is enforced by the core: beginExecute() requires the plan
 * to be approved (alwaysRequireApproval: true for eSign). The human approves
 * via the localhost approval server, which runs in this same process.
 *
 * Run with: node mcp/foxit/esign-mcp-server.mjs
 * Connects over stdio transport + localhost HTTP approval UI.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createApprovalServer } from "safe-write-mcp-core";

import {
  createEsignStore,
  createEsignFolder,
  beginEsignSend,
  confirmEsignExecuted,
  confirmEsignFailed,
  listExecutingPlans,
  reconcileEsignPlan,
} from "./esign-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Journal path — durable state lives alongside this script.
const JOURNAL_PATH = process.env.ESIGN_JOURNAL_PATH ?? join(__dirname, ".esign-journal.jsonl");

// Lazily-initialized store. Tools call getStore() so the first tool call
// initializes the store (and replays the journal for crash recovery).
let store = null;

/**
 * Get or create the eSign plan store. Replays the journal on first call
 * so a restarted process recovers stuck-executing plans.
 * @returns {import("./esign-adapter.mjs").PlanStore}
 */
function getStore() {
  if (!store) {
    store = createEsignStore(JOURNAL_PATH);
  }
  return store;
}

// --- Approval server --------------------------------------------------------
// The approval server runs in-process, sharing the same PlanStore.
// It renders the eSign plan for human review with a custom renderPlan hook.

/**
 * Render an eSign plan for the approval UI.
 * Shows the folder name, recipient list, and an explicit irrevocability warning.
 * Does NOT dump the raw payload JSON (which would leak PII).
 * @param {import("safe-write-mcp-core/dist/approvalServer.js").PendingPlan<any>} plan
 * @returns {import("safe-write-mcp-core/dist/approvalServer.js").RenderablePlan}
 */
function renderEsignPlan(plan) {
  const payload = plan.payload || {};
  const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
  const folderName = payload.folderName || "(unnamed)";
  const folderId = payload.folderId || plan.extra?.folderId || "—";

  const recipientRows = recipients
    .map((r, i) => `${i + 1}. ${r.firstName ?? "?"} ${r.lastName ?? "?"} <${r.email ?? "?"}>`)
    .join("\n");

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

// Module-level payload storage — the MCP server is stateless between calls,
// so we retain the payload from esign_create_draft here for begin_send.
/** @type {Map<string, any>} */
const payloadCache = new Map();

// --- MCP server -------------------------------------------------------------

const server = new McpServer({
  name: "no-undo-esign",
  version: "0.1.0",
  instructions:
    "Foxit eSign adapter — crash-safe two-step send for signature. " +
    "All eSign sends require human approval. Use esign_create_draft to create " +
    "a draft folder, wait for human approval via the localhost approval UI, " +
    "then esign_begin_send to transition to executing. After the gateway send, " +
    "call esign_confirm_executed or esign_confirm_failed.",
});

// --- Tool: esign_create_draft -----------------------------------------------
// Creates a draft folder (reversible) and a plan token bound to the payload.
// The plan is created with alwaysRequireApproval: true, so it cannot be
// executed without human approval.

server.registerTool(
  "esign_create_draft",
  {
    title: "Create eSign draft",
    description:
      "Create a draft folder (sendNow:false) and a plan token. " +
      "This is reversible — the folder sits in DRAFT status. " +
      "The plan requires human approval before it can be sent.",
    inputSchema: {
      folderName: z.string().describe("Name for the draft folder"),
      recipients: z
        .array(
          z.object({
            firstName: z.string(),
            lastName: z.string(),
            email: z.string().email(),
          }),
        )
        .min(1)
        .describe("List of signers"),
    },
  },
  async ({ folderName, recipients }) => {
    const s = getStore();
    const payload = { folderName, recipients };
    const result = await createEsignFolder(s, payload);
    if (result.error) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    // Cache the payload for begin_send (the MCP server is stateless between calls)
    payloadCache.set(result.planToken, payload);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              planToken: result.planToken,
              folderId: result.folderId,
              status: "awaiting_approval",
              message:
                "Draft created. Plan requires human approval. " +
                "Open the localhost approval UI to approve or reject.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// --- Tool: esign_begin_send --------------------------------------------------
// Transitions the plan to "executing". The core enforces that the plan must
// be approved first (alwaysRequireApproval). After this returns, the host
// calls sendDraftFolder() and then confirms with confirm/failed.

server.registerTool(
  "esign_begin_send",
  {
    title: "Begin eSign send",
    description:
      "Transition an approved plan to 'executing'. Requires human approval " +
      "first. After this succeeds, call the gateway send-draft endpoint, " +
      "then confirm with esign_confirm_executed or esign_confirm_failed.",
    inputSchema: {
      planToken: z.string().describe("The plan token from esign_create_draft"),
    },
  },
  async ({ planToken }) => {
    const s = getStore();
    const payload = payloadCache.get(planToken);
    if (!payload) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "payload not found — call esign_create_draft first" },
              null,
              2,
            ),
          },
        ],
      };
    }
    const result = beginEsignSend(s, planToken, payload);
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              planToken: result.planToken,
              status: "executing",
              nextStep:
                "Call the gateway send-draft endpoint, then confirm with " +
                "esign_confirm_executed or esign_confirm_failed.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// --- Tool: esign_confirm_executed --------------------------------------------
// Marks the plan used after the gateway send succeeds.

server.registerTool(
  "esign_confirm_executed",
  {
    title: "Confirm eSign send succeeded",
    description:
      "Mark the plan as executed after the gateway send-draft call succeeds. " +
      "This audits 'executed' and marks the plan used.",
    inputSchema: {
      planToken: z.string().describe("The plan token in 'executing' state"),
    },
  },
  async ({ planToken }) => {
    const s = getStore();
    const result = await confirmEsignExecuted(s, planToken);
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ planToken, status: "executed" }, null, 2),
        },
      ],
    };
  },
);

// --- Tool: esign_confirm_failed ----------------------------------------------
// Releases the plan back to retryable after a failed send.

server.registerTool(
  "esign_confirm_failed",
  {
    title: "Confirm eSign send failed",
    description:
      "Release the plan back to retryable after a failed send. " +
      "Checks gateway folderStatus first — if the folder is already SHARED, " +
      "refuses to release (the send actually succeeded).",
    inputSchema: {
      planToken: z.string().describe("The plan token in 'executing' state"),
      reason: z.string().optional().describe("Reason for the failure"),
    },
  },
  async ({ planToken, reason }) => {
    const s = getStore();
    const result = await confirmEsignFailed(s, planToken, reason);
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { planToken, status: "retryable", message: "Plan released for retry" },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// --- Tool: esign_list_executing ----------------------------------------------
// Lists plans currently stuck in "executing" — useful for health checks.

server.registerTool(
  "esign_list_executing",
  {
    title: "List executing eSign plans",
    description:
      "List plans currently stuck in 'executing' state. " +
      "These need to be reconciled (the process may have died mid-send).",
    inputSchema: {},
  },
  async () => {
    const s = getStore();
    const plans = listExecutingPlans(s);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ executing: plans, count: plans.length }, null, 2),
        },
      ],
    };
  },
);

// --- Tool: esign_reconcile ---------------------------------------------------
// Reconciles a stuck plan against the gateway folderStatus.

server.registerTool(
  "esign_reconcile",
  {
    title: "Reconcile stuck eSign plan",
    description:
      "Reconcile a stuck-executing plan by checking the gateway folderStatus. " +
      "SHARED → mark executed. DRAFT → release for retry. Unknown → keep stuck.",
    inputSchema: {
      planToken: z.string().describe("The stuck plan token"),
    },
  },
  async ({ planToken }) => {
    const s = getStore();
    const result = await reconcileEsignPlan(s, planToken);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ planToken, ...result }, null, 2),
        },
      ],
    };
  },
);

// --- Main -------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[esign-mcp-server] connected over stdio");
}

main().catch((err) => {
  console.error("[esign-mcp-server] fatal:", err);
  process.exit(1);
});
