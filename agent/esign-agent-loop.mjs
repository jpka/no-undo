/**
 * Agent loop orchestration — prompt to signed document.
 *
 * Wires three pieces together:
 *   1. Foxit PDF MCP server — reversible document work (assembly, conversion, OCR, merge).
 *   2. eSign adapter — the crash-safe gate around the irreversible send.
 *   3. localhost approval server — renders the plan for human review (custom renderPlan hook).
 *
 * Pipeline:
 *   1. Messy input document → Foxit MCP assembly/conversion tools (all reversible).
 *   2. eSign adapter creates a draft folder (reversible) + plan token.
 *   3. Approval server renders document + recipients, human approves/rejects.
 *   4. Agent transitions plan to "executing" → gateway send → confirm.
 *
 * Crash story: beginExecute fsyncs "executing" before the gateway call.
 * NO_UNDO_CRASH_AFTER_FSYNC=1 SIGKILLs there; restart replays the journal
 * and reconcile asks folderStatus DRAFT vs SHARED — never double-sends.
 *
 * The custom renderPlan hook renders the folder name, recipient list, and an
 * explicit irrevocability warning — NOT JSON.stringify (the core default, which
 * the build plan flags as embarrassing for a PII demo).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startApprovalServer } from "safe-write-mcp-core";
import {
  loadEsignStore,
  createEsignFolder,
  beginEsignSend,
  sendDraftFolder,
  confirmEsignExecuted,
  confirmEsignFailed,
  listExecutingPlans,
} from "../mcp/foxit/esign-adapter.mjs";
import { parsePrompt } from "../mcp/foxit/prompt-parser.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Custom renderPlan hook -------------------------------------------------

/**
 * Render an eSign plan for the approval UI.
 * Shows the prompt excerpt, parsed folder name, recipient list, and an
 * explicit irrevocability warning. Does NOT dump the raw payload JSON.
 * @param {import("safe-write-mcp-core/dist/approvalServer.js").PendingPlan<any>} plan
 * @returns {import("safe-write-mcp-core/dist/approvalServer.js").RenderablePlan}
 */
function renderEsignPlan(plan) {
  const payload = plan.payload || {};
  const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
  const folderName = payload.folderName || "(unnamed)";
  const folderId = payload.folderId || plan.extra?.folderId || "—";
  const promptExcerpt = plan.extra?.promptExcerpt;
  const promptInstructions = plan.extra?.promptInstructions;
  const promptDocSource = plan.extra?.promptDocSource;

  const recipientRows = recipients
    .map((r, i) => `${i + 1}. ${r.firstName ?? "?"} ${r.lastName ?? "?"} <${r.email ?? "?"}>`)
    .join("\n");

  const details = [];
  if (promptExcerpt) {
    details.push({ label: "Prompt", value: promptExcerpt });
  }
  details.push({ label: "Folder", value: folderName });
  details.push({ label: "Folder ID", value: String(folderId) });
  details.push({ label: "Recipients", value: recipientRows || "(none)" });
  if (promptDocSource) {
    details.push({ label: "Document source", value: promptDocSource });
  }
  if (promptInstructions) {
    details.push({ label: "Instructions", value: promptInstructions });
  }
  details.push({ label: "Agent's reason", value: plan.reason || "(none given)" });
  details.push({
    label: "⚠️ Irreversible",
    value:
      "Approving sends this document to the listed recipients for signature. " +
      "This action cannot be undone. Emails will be sent immediately.",
  });

  return {
    title: `✍️  Sign: ${folderName}`,
    details,
  };
}

// --- Prompt-driven entry point ----------------------------------------------

/**
 * Run the full pipeline from a single natural-language prompt. Parses the
 * prompt into a typed EsignPayload, then delegates to runAgentLoop. The
 * parsed fields are echoed back in the approval card for human correction
 * before any irreversible step.
 * @param {string} prompt
 * @param {{journalPath?: string, autoApprove?: boolean, approvalTimeoutMs?: number}} [options]
 * @returns {Promise<object>}
 */
export async function runFromPrompt(prompt, options = {}) {
  const parsed = parsePrompt(prompt);
  console.error(`[agent] Parsed prompt: folderName="${parsed.folderName}" recipients=${parsed.recipients.length}`);
  return runAgentLoop({
    folderName: parsed.folderName,
    recipients: parsed.recipients,
    journalPath: options.journalPath,
    autoApprove: options.autoApprove,
    approvalTimeoutMs: options.approvalTimeoutMs,
    promptExcerpt: parsed.promptExcerpt,
    promptInstructions: parsed.instructions,
    promptDocSource: parsed.docSource,
  });
}

// --- Main agent loop --------------------------------------------------------

/**
 * Poll the store until the plan leaves "awaiting_approval" (approved,
 * rejected, or expired). The approval server mutates the same store in-process
 * so no IPC is needed — this just watches the store's pending list.
 * @param {import("safe-write-mcp-core").PlanStore<any>} store
 * @param {string} planToken
 * @param {{timeoutMs: number, pollMs: number}} opts
 * @returns {Promise<"approved"|"rejected"|"expired"|"timeout">}
 */
async function waitForDecision(store, planToken, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillPending = store.listPending().some((p) => p.planToken === planToken);
    if (!stillPending) {
      // Not pending — probe with idempotent approve(). Rejected and expired
      // are distinguishable here; approved (or never-gated) succeeds.
      const probe = store.approve(planToken);
      if (!probe.ok) {
        const code = probe.error?.code;
        if (code === "PLAN_REJECTED") return "rejected";
        if (code === "PLAN_EXPIRED") return "expired";
        // Unknown token or other error — treat as expired (not approvable)
        return "expired";
      }
      return "approved";
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return "timeout";
}

/**
 * Run the full pipeline: create draft → approval → execute → reconcile.
 * The store and approval server are shared in this process — the same
 * arrangement mcp/foxit/esign-mcp-server.mjs uses, so a plan approved in
 * the browser is visible to beginEsignSend here.
 *
 * @param {object} options
 * @param {string} options.folderName
 * @param {Array<{firstName: string, lastName: string, email: string}>} options.recipients
 * @param {string} [options.journalPath] - path for the durable journal + audit sink
 * @param {boolean} [options.autoApprove] - if true, approve without human interaction (for tests/CI)
 * @param {number} [options.approvalTimeoutMs] - how long to wait for human approval
 */
export async function runAgentLoop({
  folderName,
  recipients,
  journalPath,
  autoApprove = false,
  approvalTimeoutMs = 5 * 60 * 1000,
  promptExcerpt = null,
  promptInstructions = null,
  promptDocSource = null,
}) {
  const resolvedJournal =
    journalPath ?? resolve(__dirname, "../mcp/foxit/.esign-journal.jsonl");

  console.error(`[agent] Journal: ${resolvedJournal}`);

  // Recover any stuck-executing plan from a previous crash before accepting
  // new work — PlanStore.fromJournal replays and reconciles via the adapter's
  // folderStatus hook.
  const store = await loadEsignStore(resolvedJournal);

  // loadEsignStore already replayed the journal and reconciled each
  // executing token via the adapter's folderStatus hook (DRAFT→not-done,
  // SHARED→done, unknown→stays executing). Leftover entries are unknowns
  // that need human inspection — do not re-reconcile them here.
  const stuck = listExecutingPlans(store);
  if (stuck.length > 0) {
    console.error(`[agent] Recovered ${stuck.length} stuck-executing plan(s) (outcome unknown, reconciled on load):`);
    for (const p of stuck) {
      console.error(`  - ${p.planToken.slice(0, 8)}... folderId=${p.extra?.folderId ?? "?"}`);
    }
    console.error(
      `[agent] ${stuck.length} plan(s) remain executing (outcome unknown) — human must resolve`,
    );
    // Do not start a new draft while an ambiguous send is unresolved.
    // The caller must reconcile the stuck plan(s) first (via the approval
    // UI or reconcile tool). Return immediately before opening the server.
    return {
      status: "executing",
      note: `${stuck.length} stuck plan(s) remain; human resolution required`,
      stuck: stuck.map((p) => ({ planToken: p.planToken, folderId: p.extra?.folderId })),
    };
  }

  // Start the approval server sharing this store.
  const approvalHandle = await startApprovalServer(store, {
    renderPlan: renderEsignPlan,
    title: "eSign Approval Queue",
  });
  console.error(
    `[agent] Approval server: http://${approvalHandle.host}:${approvalHandle.port}`,
  );

  let result;
  try {
    // Step 1: Create draft folder (reversible, DRAFT status) + plan token.
    console.error("[agent] Creating draft folder…");
    const payload = { folderName, recipients };
    const created = await createEsignFolder(store, payload, {
      extra: { promptExcerpt, promptInstructions, promptDocSource },
    });
    if (created.error) {
      throw new Error(`createfolder failed: ${created.error} (status ${created.status ?? "?"})`);
    }
    const { planToken, folderId } = created;
    console.error(`[agent] Draft: folderId=${folderId} planToken=${planToken.slice(0, 8)}…`);

    if (autoApprove) {
      const a = store.approve(planToken);
      if (!a.ok) throw new Error(`auto-approve failed: ${a.error?.message ?? "unknown"}`);
      console.error("[agent] Auto-approved (no human interaction)");
    } else {
      console.error("[agent] Awaiting human approval — open the approval URL above");
      const decision = await waitForDecision(store, planToken, {
        timeoutMs: approvalTimeoutMs,
        pollMs: 500,
      });
      if (decision === "timeout") {
        return { planToken, folderId, status: "awaiting_approval", note: "approval timed out" };
      }
      if (decision === "rejected") {
        return { planToken, folderId, status: "rejected" };
      }
      if (decision === "expired") {
        return { planToken, folderId, status: "not_executed", error: "plan expired", code: "PLAN_EXPIRED" };
      }
      // "approved" — fall through to execute
    }

    // Step 2: Transition to executing. This fsyncs "executing" to the journal
    // BEFORE the gateway call — the crash injection point is inside here.
    console.error("[agent] beginExecute…");
    const begin = beginEsignSend(store, planToken, payload);
    if (!begin.ok) {
      // PLAN_REJECTED, AWAITING_APPROVAL, EXPIRED, etc. — human rejected or race
      return { planToken, folderId, status: "not_executed", error: begin.error, code: begin.code };
    }
    console.error("[agent] Plan is executing — calling gateway sendDraftFolder…");

    // Step 3: Irreversible gateway call.
    const send = await sendDraftFolder(folderId);
    if (send.ok) {
      const c = await confirmEsignExecuted(store, planToken);
      if (!c.ok) throw new Error(`confirmExecuted failed: ${c.error}`);
      console.error("[agent] Send succeeded — plan executed");
      result = { planToken, folderId, status: "executed" };
    } else if (send.transportError) {
      // Ambiguous — may have been applied before the connection broke.
      // Leave executing and let reconcile decide; do not confirmFailed.
      console.error("[agent] Transport error — plan left executing for reconcile");
      result = {
        planToken,
        folderId,
        status: "executing",
        note: "transport error, reconcile required",
      };
    } else {
      // Definite rejection (4xx/5xx) — but still verify folderStatus before
      // releasing, via confirmEsignFailed's DRAFT/SHARED guard.
      const c = await confirmEsignFailed(store, planToken, `gateway ${send.status}`);
      if (!c.ok) {
        // SHARED or unknown — retained executing for reconcile, not released
        console.error(`[agent] confirmFailed refused: ${c.error} — retained executing`);
        result = { planToken, folderId, status: "executing", note: c.error };
      } else {
        console.error("[agent] Send failed — plan released for retry");
        result = { planToken, folderId, status: "failed", gatewayStatus: send.status };
      }
    }
  } finally {
    await approvalHandle.close().catch(() => {});
  }

  return result;
}

// --- CLI --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const autoApprove = args.includes("--auto-approve");
  const promptIdx = args.indexOf("--prompt");
  let prompt = promptIdx >= 0 ? args[promptIdx + 1] : null;
  if (prompt?.startsWith("--")) prompt = null;

  let result;
  if (prompt) {
    result = await runFromPrompt(prompt, { autoApprove });
  } else {
    const folderName = args.find((a) => !a.startsWith("--")) ?? "demo-contract";
    result = await runAgentLoop({
      folderName,
      recipients: [
        { firstName: "Alice", lastName: "Smith", email: "alice@example.com" },
        { firstName: "Bob", lastName: "Jones", email: "bob@example.com" },
      ],
      autoApprove,
    });
  }
  console.error("[agent] Result:", JSON.stringify(result, null, 2));
  switch (result?.status) {
    case "executed":
      process.exit(0);
    case "awaiting_approval":
      process.exit(0);
    case "failed":
      process.exit(2);
    case "rejected":
    case "not_executed":
      process.exit(3);
    case "executing":
      // Outcome unknown — reconcile required before the send can be trusted.
      process.exit(4);
    default:
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[agent] Fatal:", err);
    process.exit(1);
  });
}

export { renderEsignPlan };
