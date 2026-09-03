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

import { dirname, resolve, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startStyledApprovalServer } from "../mcp/lib/approval-ui.mjs";
import {
  loadEsignStore,
  createEsignFolder,
  beginEsignSend,
  sendDraftFolder,
  confirmEsignExecuted,
  confirmEsignFailed,
  listExecutingPlans,
  getReconcileReport,
  maybeCrashAfterSend,
  pollUntilSigned,
  downloadSignedDocument,
  checkFolderStatus,
  isSentStatus,
} from "../mcp/foxit/esign-adapter.mjs";
import { parsePrompt, parseRecipientFlag, mergeRecipients, RecipientSchema } from "../mcp/foxit/prompt-parser.mjs";
import { writeFileSync, writeSync, readFileSync, existsSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Custom renderPlan hook -------------------------------------------------

/**
 * Break an em-dash-joined summary into one clause per line.
 *
 * The extraction and redaction summaries are built as single strings so they
 * can go in a log line, and on the card that arrives as an unreadable run-on.
 * `pre` in the approval page is already `white-space: pre-wrap`, so newlines
 * render with no CSS at all. Splits only at top level — the redaction summary
 * carries an em dash inside its parenthetical ("— pattern withheld from this
 * view"), and breaking there would split the clause from its own caveat.
 *
 * @param {string} summary
 * @returns {string}
 */
function asLines(summary) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < summary.length; i++) {
    const ch = summary[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && summary.startsWith(" — ", i)) {
      parts.push(summary.slice(start, i));
      i += 2;
      start = i + 1;
    }
  }
  parts.push(summary.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean).join("\n");
}

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
    .map((r, i) => {
      const addr = r.email ?? "?";
      const warning = r.resolved === false ? " ⚠️ UNRESOLVED — will not be sent live" : "";
      return `${i + 1}. ${r.firstName ?? "?"} ${r.lastName ?? "?"} <${addr}>${warning}`;
    })
    .join("\n");

  // Ordered by what a reviewer needs to decide, not by what is easy to emit.
  // Blast radius first (who this reaches), then the evidence, then what the
  // pipeline is unsure about, then the warning. The quiet provenance rows sit
  // below that — they explain how we got here, they don't change the decision.
  const details = [];
  details.push({ label: "Recipients", value: recipientRows || "(none)" });
  details.push({ label: "Folder", value: folderName });

  // Foxit-assembled document digest (build-plan step 3: pdf_from_html bytes → SHA-256).
  // Printed in full and deliberately: a reviewer's use for this is to compare it
  // against an external record, which a truncated digest cannot support. It is
  // not meant to be read, and the card's ordering treats it accordingly.
  const documentSha256 = plan.extra?.documentSha256;
  if (documentSha256) {
    const via = plan.extra?.documentVia ? ` (via ${plan.extra.documentVia})` : "";
    details.push({ label: "Document SHA-256", value: `${documentSha256}${via}` });
  }

  // What was removed from the document, and the confirmation that it is gone.
  // The reviewer needs both: the detector's inventory says what was looked for,
  // the verification says what is actually absent from the bytes being sent.
  const redactionSummary = plan.extra?.redactionSummary;
  if (redactionSummary) {
    details.push({ label: "Nutrient redaction", value: asLines(redactionSummary) });
  }

  // Optional Nutrient enrichment summary (P6 pipeline: extraction → redaction before gate)
  const nutrientSummary = plan.extra?.nutrientSummary;
  if (nutrientSummary) {
    details.push({ label: "Nutrient extraction", value: asLines(nutrientSummary) });
  }

  details.push({
    label: "⚠️ Irreversible",
    value:
      "Approving sends this document to the listed recipients for signature. " +
      "This action cannot be undone. Emails will be sent immediately.",
  });

  // Provenance — how the plan was arrived at. Kept, but after the decision.
  if (promptExcerpt) {
    details.push({ label: "Prompt", value: promptExcerpt });
  }
  if (promptDocSource) {
    details.push({ label: "Document source", value: promptDocSource });
  }
  if (promptInstructions) {
    details.push({ label: "Instructions", value: promptInstructions });
  }
  details.push({ label: "Folder ID", value: String(folderId) });
  // No "Agent's reason" row here — the approval server already renders
  // plan.reason as "Reason given by agent". Pushing it again printed it twice.

  return {
    title: `✍️  Sign: ${folderName}`,
    details,
  };
}

// --- Nutrient enrichment (P6: real extraction + routing) --------------------

const EXTRACT_URL = "https://api.nutrient.io/extraction/extract";
const API_VERSION = "2026-05-25";

/**
 * Whether Nutrient enrichment should be attempted for this run.
 * The extraction path authenticates exclusively with the configured extraction
 * key (`NUTRIENT_DWS_EXTRACTION_API_KEY`) — the processor key is not used by
 * this path, so requiring it would silently skip extraction for anyone who
 * provisioned only the extraction service (gh #53 review).
 * `NO_NUTRIENT=1` forces Foxit-only even when the key is present (CI,
 * single-cred repro).
 * @returns {boolean}
 */
export function shouldEnrichWithNutrient() {
  if (process.env.NO_NUTRIENT === "1") return false;
  return Boolean(process.env.NUTRIENT_DWS_EXTRACTION_API_KEY);
}

/**
 * Best-effort Nutrient enrichment before the gate.
 *
 * Reversible, unattended steps that run BEFORE Foxit assembly / the approval gate:
 * if document bytes are available and both API keys are present, upload them to
 * the real `/extraction/extract` endpoint, route each field through `routeFields`,
 * and return an honest summary for the approval card. Any failure is logged and
 * swallowed — enrichment never blocks the Foxit-only send, which is the graded
 * path for the Foxit track.
 *
 * The approval card reflects what actually happened: how many fields auto-approved
 * vs. need human review, the specific fields the OCR recognition floor caught, and
 * the ungrounded (not_found) fields — it never claims a capability the code didn't
 * exercise (gh #34).
 *
 * @param {{promptExcerpt?: string, docSource?: string|null, folderName: string}} parsed
 * @param {{journalPath?: string, docBytes?: Uint8Array}} [options]
 * @returns {Promise<{summary: string, bytes?: Uint8Array}|null>}
 */
export async function enrichWithNutrient(parsed, options = {}) {
  if (!shouldEnrichWithNutrient()) return null;

  // Resolve document bytes — explicit bytes win, then docSource file.
  let docBytes = options.docBytes ?? null;
  if (!docBytes && parsed.docSource) {
    const candidates = [
      parsed.docSource,
      resolvePath(process.cwd(), parsed.docSource),
      resolvePath(__dirname, "..", parsed.docSource),
    ];
    for (const p of candidates) {
      try {
        if (existsSync(p)) {
          docBytes = readFileSync(p);
          break;
        }
      } catch {
        // ignore and try next
      }
    }
  }
  if (!docBytes) {
    // No bytes — report that enrichment was wired but skipped for lack of a file.
    return { summary: "Nutrient enrichment wired — no document bytes (Foxit-only document will be assembled)" };
  }

  // Both keys present and bytes available — make a real extraction call.
  const key = process.env.NUTRIENT_DWS_EXTRACTION_API_KEY;
  const { routeFields, summarizeRouting, INVOICE_SCHEMA } = await import(
    "../mcp/nutrient/extraction-adapter.mjs"
  );

  const upload = docBytes instanceof Uint8Array ? docBytes : new Uint8Array(docBytes);
  const body = new FormData();
  body.append("file", new Blob([upload]), "document.pdf");
  body.append(
    "instructions",
    JSON.stringify({
      schema: INVOICE_SCHEMA,
      parseConfig: { mode: "understand" },
      options: { includeCitations: true, strict: false, multimodal: false },
    }),
  );

  let res;
  try {
    res = await fetch(EXTRACT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "x-nutrient-api-version": API_VERSION },
      body,
      signal: AbortSignal.timeout(180_000),
      redirect: "error",
    });
  } catch (e) {
    console.error(
      `[pipeline] Nutrient extraction transport error (degraded to Foxit-only): ${e instanceof Error ? e.message : String(e)}`,
    );
    return {
      summary: `Nutrient enrichment — document staged (${upload.length} bytes), extraction transport error (Foxit-only path continues)`,
      bytes: upload,
    };
  }

  let raw;
  try {
    raw = await res.text();
  } catch (e) {
    console.error(
      `[pipeline] Nutrient extraction response error (degraded to Foxit-only): ${e instanceof Error ? e.message : String(e)}`,
    );
    return {
      summary: `Nutrient enrichment — document staged (${upload.length} bytes), extraction response error (Foxit-only path continues)`,
      bytes: upload,
    };
  }
  if (!res.ok) {
    console.error(`[pipeline] Nutrient extraction HTTP ${res.status} (degraded to Foxit-only): ${raw.slice(0, 200)}`);
    return {
      summary: `Nutrient enrichment — document staged (${upload.length} bytes), extraction HTTP ${res.status} (Foxit-only path continues)`,
      bytes: upload,
    };
  }

  let parsedResponse;
  try {
    parsedResponse = JSON.parse(raw);
  } catch {
    console.error("[pipeline] Nutrient extraction returned non-JSON (degraded to Foxit-only)");
    return {
      summary: `Nutrient enrichment — document staged (${upload.length} bytes), extraction returned non-JSON (Foxit-only path continues)`,
      bytes: upload,
    };
  }
  if (!parsedResponse?.output || typeof parsedResponse.output !== "object") {
    console.error("[pipeline] Nutrient extraction response has no `output` object (degraded to Foxit-only)");
    return {
      summary: `Nutrient enrichment — document staged (${upload.length} bytes), extraction response malformed (Foxit-only path continues)`,
      bytes: upload,
    };
  }

  const output = parsedResponse.output;
  // routeFields walks the UNION of output.data and output.metadata — not_found
  // fields are absent from data but present in metadata, so a data-driven walk
  // would silently drop the most important routing signal (finding A, build-plan.md:120).
  const routed = routeFields(output.data ?? {}, output.metadata ?? {}, { documentType: "invoice" });
  const summary = summarizeRouting(routed);

  // Build an honest summary for the approval card — no string claims a
  // capability the code didn't exercise (gh #34). The dissenting signal
  // (OCR recognition floor) is named explicitly, because that is the entire story.
  const human = routed.fields.filter((f) => f.route === "human");
  const vetoedByOcr = routed.fields.filter((f) => f.reason.startsWith("recognitionScore"));
  const notFound = routed.fields.filter((f) => f.match === "not_found");

  // The approval card already labels this line "Nutrient extraction"; repeating
  // the words in the value reads as a stutter on the card the judge looks at.
  const parts = [`${summary.auto}/${summary.total} fields auto-approved`];
  if (human.length > 0) {
    parts.push(`${human.length} need human review`);
  }
  if (vetoedByOcr.length > 0) {
    const names = vetoedByOcr.map((f) => f.field).join(", ");
    parts.push(`${vetoedByOcr.length} caught by OCR recognition floor: ${names}`);
  }
  if (notFound.length > 0) {
    const names = notFound.map((f) => f.field).join(", ");
    parts.push(`${notFound.length} ungrounded (not_found): ${names}`);
  }
  // Thresholds are uncalibrated — say so honestly (a test enforces calibrated: false).
  parts.push(`thresholds calibrated: ${routed.limits.calibrated}`);

  const summaryStr = parts.join(" — ");
  console.error(`[pipeline] Nutrient extraction: ${summaryStr}`);
  return { summary: summaryStr, bytes: upload };
}

// --- Prompt-driven entry point ----------------------------------------------

/**
 * Run the full pipeline from a single natural-language prompt. Parses the
 * prompt into a typed EsignPayload, then delegates to runAgentLoop. The
 * parsed fields are echoed back in the approval card for human correction
 * before any irreversible step.
 * @param {string} prompt
 * @param {{journalPath?: string, autoApprove?: boolean, approvalTimeoutMs?: number, allowUntaggedEnrichedPdf?: boolean, recipients?: Array<{firstName: string, lastName: string, email: string, resolved?: boolean}>}} [options]
 * @returns {Promise<object>}
 */
export async function runFromPrompt(prompt, options = {}) {
  const parsed = await parsePrompt(prompt);
  // Parse any explicit --recipient flags into resolved recipients. These
  // override the parser's guesses — if provided, they fully replace the
  // parsed list.
  const overrides = (options.recipients ?? []).map((r) => {
    // Validate programmatic overrides through the same schema as CLI/prompt
    // recipients so malformed values fail fast with clear diagnostics
    // instead of producing a late gateway failure.
    RecipientSchema.parse({ ...r, resolved: true });
    return { firstName: r.firstName, lastName: r.lastName, email: r.email, resolved: true };
  });
  const recipients = mergeRecipients(parsed.recipients, overrides);
  let nutrientSummary = null;
  console.error(`[agent] Parsed prompt: folderName="${parsed.folderName}" recipients=${recipients.length}`);
  // Nutrient stage (reversible, before the gate, one PlanStore). Foxit-only
  // remains the single-credential repro when keys are absent.
  //
  // Ordering matters and was wrong before: enrichment ran BEFORE the document
  // existed, so `docBytes` was null on the demo prompt and every Nutrient call
  // was skipped with "no document bytes". Assembly now happens here, so both
  // extraction and redaction operate on a real document.
  // The document that gets SIGNED is always the one this pipeline assembles and
  // redacts. `options.docBytes` is the source document extraction READS (a scan,
  // via --doc); it is not signable — it carries no Foxit Text Tags, so passing it
  // through here produced a draft the gateway would refuse.
  let pdfBytes = null;
  let signatureTagsVerified = null;
  let redactionSummary = null;

  if (shouldEnrichWithNutrient()) {
    const { assemblePdf } = await import("../mcp/foxit/pdf-assembly.mjs");
    const assemblePayload = {
      folderName: parsed.folderName,
      recipients,
      instructions: parsed.instructions,
      docSource: parsed.docSource,
    };
    console.error("[agent] Assembling document via Foxit MCP (reversible)…");
    const assembled = await assemblePdf(assemblePayload, {});
    const assembledBytes = new Uint8Array(Buffer.from(assembled.base64, "base64"));
    console.error(`[agent] Assembled ${assembledBytes.length} bytes via ${assembled.via}`);

    // Extraction runs on the caller-supplied source document when there is one
    // (the messy invoice), otherwise on the document we just assembled. The
    // approval card names which, because the two say very different things
    // about how much judgement the routing actually exercised.
    const extractionBytes = options.docBytes ?? assembledBytes;
    const extractionSource = options.docBytes ? "source document" : "assembled invoice";
    const enrichment = await enrichWithNutrient(parsed, {
      docBytes: extractionBytes,
      journalPath: options.journalPath,
    });
    if (enrichment?.summary) {
      nutrientSummary = `${enrichment.summary} [on the ${extractionSource}]`;
      console.error(`[agent] Nutrient: ${nutrientSummary}`);
    }

    // Redaction: stage → apply → verify, on the assembled document, before the
    // gate. Unlike extraction, this CANNOT degrade to a Foxit-only send: the
    // prompt asked for the PII to be removed, so failing to remove it must stop
    // the run rather than quietly ship the document. Aborting here also means no
    // draft folder is created, so there is nothing left in DRAFT to clean up.
    const { redactForSignature, piiValuesOf } = await import("../mcp/nutrient/pipeline-redaction.mjs");
    const { INVOICE } = await import("../mcp/fixtures/invoice-data.mjs");
    const expectedTagSeqs = recipients.map((_, i) => i + 1);
    console.error("[agent] Nutrient redaction: stage → apply → verify…");
    const red = await redactForSignature(assembledBytes, {
      mustBeAbsent: piiValuesOf(INVOICE),
      expectedTagSeqs,
    });
    if (!red.ok) {
      console.error(`[agent] ABORT: redaction ${red.stage} step failed — ${red.error}`);
      return {
        status: "not_executed",
        error: `redaction ${red.stage} failed: ${red.error}`,
        code: "REDACTION_FAILED",
      };
    }
    pdfBytes = red.bytes;
    signatureTagsVerified = expectedTagSeqs;
    redactionSummary = red.summary;
    console.error(`[agent] Nutrient redaction: ${red.summary}`);
    // stagedBytes is null unless stageFirst was requested — the staging call is
    // billed and its result is discarded, so the pipeline skips it by default.
    const stagedLeg = red.stagedBytes === null ? "" : ` → staged ${red.stagedBytes}`;
    console.error(`[agent] Redaction bytes: assembled ${assembledBytes.length}${stagedLeg} → applied ${red.appliedBytes}`);
  }
  return runAgentLoop({
    folderName: parsed.folderName,
    recipients,
    journalPath: options.journalPath,
    autoApprove: options.autoApprove,
    approvalTimeoutMs: options.approvalTimeoutMs,
    promptExcerpt: parsed.promptExcerpt,
    promptInstructions: parsed.instructions,
    promptDocSource: parsed.docSource,
    nutrientSummary,
    redactionSummary,
    pdfBytes,
    signatureTagsVerified,
    allowUntaggedEnrichedPdf: options.allowUntaggedEnrichedPdf ?? false,
    pollForSigned: options.pollForSigned,
    pollTimeoutMs: options.pollTimeoutMs,
    downloadSigned: options.downloadSigned,
    signedOutputPath: options.signedOutputPath,
    allowFixturePdf: options.allowFixturePdf ?? false,
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
  nutrientSummary = null,
  redactionSummary = null,
  pdfBytes = null,
  signatureTagsVerified = null,
  allowUntaggedEnrichedPdf = false,
  pollForSigned = false,
  pollTimeoutMs = 30_000,
  downloadSigned = false,
  signedOutputPath = null,
  allowFixturePdf = false,
}) {
  const resolvedJournal =
    journalPath ??
    (process.env.ESIGN_JOURNAL_PATH
      ? resolvePath(process.env.ESIGN_JOURNAL_PATH)
      : undefined) ??
    resolve(__dirname, "../mcp/foxit/.esign-journal.jsonl");

  // Ensure the journal's parent directory exists — ESIGN_JOURNAL_PATH often
  // points at a fresh location (demo runs, temp dirs). Fail clearly if not.
  const journalDir = dirname(resolvedJournal);
  mkdirSync(journalDir, { recursive: true });

  console.error(`[agent] Journal: ${resolvedJournal}`);

  // Recover any stuck-executing plan from a previous crash before accepting
  // new work — PlanStore.fromJournal replays and reconciles via the adapter's
  // folderStatus hook.
  const store = await loadEsignStore(resolvedJournal);

  // Narrate what the store resolved during replay — the demo beat.
  // loadEsignStore captures each reconciled token's observed folderStatus and
  // decision (done→confirmed executed, not-done→released, unknown→retained).
  // Previously we only printed when something remained stuck, so the successful
  // path (SHARED → confirmed executed) was silent — the crash demo's whole
  // point produced one word of output. Now we report regardless.
  const reconcileReport = getReconcileReport(store);
  if (reconcileReport.length > 0) {
    console.error(`[agent] Recovered ${reconcileReport.length} stuck-executing plan(s) (reconciled on load):`);
    for (const r of reconcileReport) {
      const short = r.planToken.slice(0, 8);
      const statusStr = r.folderStatus ?? "unknown";
      console.error(`  - planToken=${short}... folderId=${r.folderId ?? "?"} → folderStatus=${statusStr} → ${r.decision}`);
    }
  }

  // Leftover entries are unknowns that need human inspection — do not
  // re-reconcile them here.
  const stuck = listExecutingPlans(store);
  if (stuck.length > 0) {
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
  const approvalHandle = await startStyledApprovalServer(store, {
    renderPlan: renderEsignPlan,
    title: "eSign Approval Queue",
  });
  console.error(
    `[agent] Approval server: http://${approvalHandle.host}:${approvalHandle.port}/` +
      (approvalHandle.token ? `?token=${approvalHandle.token}` : ""),
  );

  let result;
  try {
    // Step 1: Create draft folder (reversible, DRAFT status) + plan token.
    console.error("[agent] Creating draft folder…");
    const payload = { folderName, recipients };
    const created = await createEsignFolder(store, payload, {
      extra: { promptExcerpt, promptInstructions, promptDocSource, nutrientSummary, redactionSummary },
      instructions: promptInstructions,
      docSource: promptDocSource,
      pdfBytes,
      signatureTagsVerified,
      allowUntaggedEnrichedPdf,
    });
    if (created.error) {
      throw new Error(`createfolder failed: ${created.error} (status ${created.status ?? "?"})`);
    }
    const { planToken, folderId, documentVia, documentSha256 } = created;
    console.error(`[agent] Draft: folderId=${folderId} planToken=${planToken.slice(0, 8)}… documentVia=${documentVia} documentSha256=${documentSha256.slice(0, 16)}…`);

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

    // Refuse to send if any recipient has a synthesized (unresolved) email.
    // The parser falls back to Alice/Bob or matches bare names against
    // KNOWN_NAMES — neither is a real address. The only safe paths are:
    // emails written in the prompt itself, or --recipient overrides.
    const unresolved = recipients.filter((r) => r.resolved === false);
    if (unresolved.length > 0) {
      const names = unresolved.map((r) => `${r.firstName} ${r.lastName} <${r.email}>`).join(", ");
      console.error(`[agent] ABORT: unresolved recipient(s) — ${names}. Use --recipient "Name <addr>" to specify real addresses.`);
      return {
        planToken,
        folderId,
        status: "not_executed",
        error: `unresolved recipient(s): ${names}`,
        code: "UNRESOLVED_RECIPIENTS",
      };
    }

    // Step 2: Transition to executing. This fsyncs "executing" to the journal
    // BEFORE the gateway call — the crash injection point is inside here.
    console.error("[agent] beginExecute…");
    const begin = beginEsignSend(store, planToken, payload, {
      documentVia,
      allowFixturePdf,
    });
    if (!begin.ok) {
      // PLAN_REJECTED, AWAITING_APPROVAL, EXPIRED, FIXTURE_PDF_REQUIRES_ALLOW_FLAG, etc.
      return { planToken, folderId, status: "not_executed", error: begin.error, code: begin.code };
    }
    console.error("[agent] Plan is executing — calling gateway sendDraftFolder…");

    // Step 3: Irreversible gateway call.
    const send = await sendDraftFolder(folderId);
    if (send.ok) {
      // Do not claim an irreversible side effect on the strength of the
      // caller's own 200 — verify against the system of record.
      // Re-read folderStatus; only SHARED/EXECUTED prove the send happened.
      let verifiedStatus;
      try {
        verifiedStatus = await checkFolderStatus(folderId);
      } catch {
        verifiedStatus = null;
      }
      if (isSentStatus(verifiedStatus)) {
        // Dangerous-window crash injection: after the gateway send AND after
        // verification confirms the folder is SHARED, before confirm. If we
        // crashed before verification and the folder stayed DRAFT (gh #43),
        // recovery would reconcile DRAFT → not-done → release for retry,
        // exercising the safe window instead. Only crash now — the true
        // dangerous window where the folder is already SHARED and recovery
        // must reconcile SHARED → confirmed executed (exactly-once). Keep
        // distinct from NO_UNDO_CRASH_AFTER_FSYNC which fires before the send.
        maybeCrashAfterSend(planToken);
        const c = await confirmEsignExecuted(store, planToken);
        if (!c.ok) throw new Error(`confirmExecuted failed: ${c.error}`);
        console.error(`[agent] Send succeeded — plan executed (verified ${verifiedStatus})`);
        result = { planToken, folderId, status: "executed", verifiedStatus, documentSha256, documentVia };
        // Optional post-send polling for the signed document (EXECUTED + download).
        // Off by default so existing tests/CI remain fast; enabled with
        // pollForSigned or downloadSigned. The send is already idempotent and
        // audit-logged — polling never re-sends, only waits for the signers to
        // finish and then fetches the signed PDF. Persist folderId+status so a
        // restart can resume polling without re-sending (see pollUntilSigned).
        if (pollForSigned || downloadSigned) {
          console.error(`[agent] Polling for signed state (EXECUTED) — timeout ${pollTimeoutMs}ms ...`);
          const polled = await pollUntilSigned(folderId, { timeoutMs: pollTimeoutMs, intervalMs: 2000 });
          result.poll = { status: polled.status, executed: polled.executed, attempts: polled.attempts, elapsedMs: polled.elapsedMs };
          if (polled.executed) {
            console.error(`[agent] Folder reached EXECUTED after ${polled.attempts} poll(s)`);
            if (downloadSigned) {
              const dl = await downloadSignedDocument(folderId, { docNumber: 0 });
              if (dl.ok && dl.bytes) {
                const outPath = signedOutputPath ?? resolve(dirname(resolvedJournal), `signed-${folderId}.pdf`);
                try {
                  writeFileSync(outPath, dl.bytes);
                  console.error(`[agent] Signed PDF written: ${outPath} (${dl.bytes.length} bytes)`);
                  result.signedPdfPath = outPath;
                  result.signedBytesLen = dl.bytes.length;
                } catch (e) {
                  console.error(`[agent] Failed to write signed PDF: ${e}`);
                  result.downloadError = String(e);
                }
              } else {
                const msg = dl.transportError ? `transport error: ${dl.text}` : `download failed HTTP ${dl.status}: ${dl.text?.slice(0,120)}`;
                console.error(`[agent] Signed PDF download failed: ${msg}`);
                result.downloadError = msg;
              }
            }
          } else {
            console.error(`[agent] Poll timed out after ${polled.attempts} attempt(s), last status=${polled.status ?? "null"} — not yet EXECUTED`);
            // Do not treat as execution failure: the send succeeded (SHARED), the document is merely not yet signed.
            // The folderId is persisted, so a later run can resume polling via pollUntilSigned or the --probe-download path.
            result.note = `sent for signature (status ${polled.status ?? "unknown"}), not yet EXECUTED`;
          }
        }
      } else if (verifiedStatus === "DRAFT") {
        console.error(`[agent] Send reported success but folderStatus=${verifiedStatus} — send did NOT happen`);
        const reason =
          send.errorDescription ??
          send.json?.error_description ??
          `folderStatus ${verifiedStatus} after send ok`;
        const c = await confirmEsignFailed(store, planToken, reason);
        if (!c.ok) {
          console.error(`[agent] confirmFailed refused: ${c.error} — retained executing`);
          result = { planToken, folderId, status: "executing", note: c.error, verifiedStatus };
        } else {
          console.error("[agent] Send not verified — plan released for retry");
          result = {
            planToken,
            folderId,
            status: "failed",
            gatewayStatus: send.status,
            verifiedStatus,
            error: reason,
          };
        }
      } else {
        // verifiedStatus === null / unknown — ambiguous, do NOT claim executed
        console.error(`[agent] Send ok but folderStatus unknown (${String(verifiedStatus)}) — leaving executing for reconcile`);
        result = {
          planToken,
          folderId,
          status: "executing",
          note: "folderStatus unknown after send — reconcile required",
          verifiedStatus,
        };
      }
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
      // Definite rejection (4xx/5xx or 200+error body) — but still verify
      // folderStatus before releasing, via confirmEsignFailed's DRAFT/SHARED guard.
      const detail = send.errorDescription ? `gateway ${send.status}: ${send.errorDescription}` : `gateway ${send.status}`;
      console.error(`[agent] Send failed — ${detail}`);
      const c = await confirmEsignFailed(store, planToken, detail);
      if (!c.ok) {
        // SHARED or unknown — retained executing for reconcile, not released
        console.error(`[agent] confirmFailed refused: ${c.error} — retained executing`);
        result = { planToken, folderId, status: "executing", note: c.error, error: detail };
      } else {
        console.error("[agent] Send failed — plan released for retry");
        result = { planToken, folderId, status: "failed", gatewayStatus: send.status, error: detail, gatewayError: send.gatewayError };
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
  const allowFixturePdf = args.includes("--allow-fixture-pdf");
  const allowUntaggedEnrichedPdf = args.includes("--allow-untagged-enriched-pdf");
  const pollForSigned = args.includes("--poll-signed");
  const downloadSigned = args.includes("--download-signed") || pollForSigned;
  const pollTimeoutIdx = args.indexOf("--poll-timeout");
  const pollTimeoutMs = pollTimeoutIdx >= 0 ? Number(args[pollTimeoutIdx + 1]) : undefined;
  // --doc <path> supplies the source document extraction reads. Without it,
  // extraction reads the invoice this pipeline just assembled, which is a clean
  // machine-rendered PDF — the routing has almost nothing to discriminate on and
  // the card says so. The interesting case is a real scan. `--doc messy` uses the
  // committed generator (skewed lines, OCR-hostile glyphs, no due date or PO
  // number) so the run is reproducible without shipping a binary.
  const docIdx = args.indexOf("--doc");
  const docArg = docIdx >= 0 && args[docIdx + 1] && !args[docIdx + 1].startsWith("--") ? args[docIdx + 1] : null;
  const promptIdx = args.indexOf("--prompt");
  let prompt = promptIdx >= 0 ? args[promptIdx + 1] : null;
  if (prompt?.startsWith("--")) prompt = null;

  // Parse repeatable --recipient "Name <addr>" flags. Explicit recipients
  // override any synthesized addresses from the parser.
  const recipientFlags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--recipient" && args[i + 1] && !args[i + 1].startsWith("--")) {
      recipientFlags.push(args[i + 1]);
    }
  }
  const recipientOverrides = recipientFlags.map((f) => parseRecipientFlag(f));

  let docBytes = null;
  if (docArg === "messy") {
    const { messyPdf } = await import("../mcp/nutrient/messy-pdf.mjs");
    docBytes = new Uint8Array(Buffer.from(messyPdf(), "latin1"));
    console.error(`[agent] Source document: generated messy invoice (${docBytes.length} bytes)`);
  } else if (docArg) {
    docBytes = new Uint8Array(readFileSync(resolvePath(docArg)));
    console.error(`[agent] Source document: ${docArg} (${docBytes.length} bytes)`);
  }

  let result;
  if (prompt) {
    result = await runFromPrompt(prompt, { autoApprove, allowFixturePdf, allowUntaggedEnrichedPdf, pollForSigned, downloadSigned, pollTimeoutMs, recipients: recipientOverrides, docBytes });
  } else {
    // Skip flag values when looking for the folder name (e.g. --recipient
    // "Name <addr>" should not be treated as the folder name).
    const flagArgs = new Set(["--prompt", "--recipient", "--poll-timeout", "--doc"]);
    const folderName = args.find((a, i) => !a.startsWith("--") && !flagArgs.has(args[i - 1])) ?? "demo-contract";
    // Explicit --recipient overrides apply even without --prompt: use them
    // instead of the unresolved fallback recipients (which would be refused).
    const recipients = recipientOverrides.length > 0
      ? recipientOverrides
      : [
          { firstName: "Alice", lastName: "Smith", email: "alice@example.com", resolved: false },
          { firstName: "Bob", lastName: "Jones", email: "bob@example.com", resolved: false },
        ];
    result = await runAgentLoop({
      folderName,
      recipients,
      autoApprove,
      allowFixturePdf,
      pollForSigned,
      pollTimeoutMs,
      downloadSigned,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    writeSync(2, `[agent] Fatal: ${err instanceof Error && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

export { renderEsignPlan };
