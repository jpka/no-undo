/**
 * Foxit eSign adapter — consumes safe-write-mcp-core v0.2.
 *
 * Wires the irreversible eSign "send for signature" action to the core's
 * crash-safe beginExecute/confirmExecuted lifecycle:
 *
 *   1. createEsignFolder() — reversible draft creation via Foxit MCP, returns
 *      a plan token bound to the draft payload.
 *   2. beginEsignSend() — core transitions the plan to "executing"; the host
 *      then calls the gateway send-draft endpoint.
 *   3. confirmEsignExecuted() — core marks the plan used; the audit log
 *      honestly claims the send only after this returns.
 *   4. confirmEsignFailed() — core releases the plan back to retryable.
 *
 * Reconcile: if the process dies mid-send, the core's fromJournal() recovers
 * the stuck-executing plan and asks our reconcile callback whether the
 * gateway actually sent it (folderStatus DRAFT = not done, SHARED = done).
 *
 * Webhook dedup: the gateway fires events on (folderId, event_name). We track
 * seen pairs to avoid double-processing.
 *
 * Gate 0 fixtures (docs/fixtures/esign-probe-aug18.txt) are the test replay
 * source — these tests do NOT call the live API.
 */

import { PlanStore } from "../../safe-write-mcp-core/src/index.js";

const GATEWAY = process.env.FOXIT_ESIGN_HOST ?? "https://na1.fusion.foxit.com";
const LEGACY = process.env.FOXIT_ESIGN_LEGACY_HOST ?? "https://na1.foxitesign.foxit.com";

const clientId = process.env.FOXIT_CLOUD_API_CLIENT_ID ?? process.env.FOXIT_CLIENT_ID;
const clientSecret =
  process.env.FOXIT_CLOUD_API_CLIENT_SECRET ?? process.env.FOXIT_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "[esign-adapter] missing credentials: set FOXIT_CLIENT_ID and FOXIT_CLIENT_SECRET",
  );
  process.exit(1);
}

/** @returns {Record<string, string>} */
function gatewayHeaders(extra = {}) {
  return { client_id: clientId, client_secret: clientSecret, ...extra };
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{ok: boolean, status: number, text: string, json: any, ms: number}>}
 */
async function req(url, init = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return { ok: res.ok, status: res.status, text, json, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, text: String(err), json: undefined, ms: Date.now() - started };
  }
}

// --- Token → folderId mapping ----------------------------------------------
// The reconcile callback only receives the planToken; this map lets it find
// the folderId to check. In a production deployment this would be a durable
// lookup; for the hackathon it is process-local.
const tokenToFolder = new Map();

// --- Webhook dedup ----------------------------------------------------------
// Gateway fires events on (folderId, event_name). A SHARED status means the
// folder was sent. We track processed pairs to avoid double-handling.
const processedEvents = new Set();

/** @param {string} folderId */
/** @param {string} eventName */
function webhookKey(folderId, eventName) {
  return `${folderId}:${eventName}`;
}

/** @param {string} folderId */
/** @param {string} eventName */
function hasProcessedWebhook(folderId, eventName) {
  return processedEvents.has(webhookKey(folderId, eventName));
}

/** @param {string} folderId */
/** @param {string} eventName */
function markWebhookProcessed(folderId, eventName) {
  processedEvents.add(webhookKey(folderId, eventName));
}

// --- Folder status check (reconcile callback) -------------------------------

/**
 * Check folderStatus on the gateway. Returns:
 *   - "SHARED" → the folder was sent (side effect happened)
 *   - "DRAFT" → the folder is still a draft (side effect did NOT happen)
 *   - null → could not determine (unknown)
 * @param {string} folderId
 * @returns {Promise<string|null>}
 */
export async function checkFolderStatus(folderId) {
  const r = await req(
    `${GATEWAY}/esign/api/v1/folders/myfolder?folderId=${encodeURIComponent(folderId)}`,
    { headers: gatewayHeaders() },
  );
  if (!r.ok) return null;
  const j = r.json;
  const folder = j?.folder;
  const status = folder?.folderStatus;
  return typeof status === "string" ? status : null;
}

// --- Send-draft call ---------------------------------------------------------

/**
 * Call the gateway send-draft endpoint. This is the irreversible action —
 * once it succeeds, the folder status flips from DRAFT to SHARED and the
 * signers receive their emails.
 * @param {string} folderId
 * @returns {Promise<{ok: boolean, status: number}>}
 */
export async function sendDraftFolder(folderId) {
  const r = await req(`${GATEWAY}/esign/api/v1/folders/sendDraftFolder`, {
    method: "POST",
    headers: gatewayHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ folderId }),
  });
  return { ok: r.ok && r.status === 200, status: r.status };
}

// --- Plan store with reconcile ----------------------------------------------

/**
 * Create a PlanStore configured for the eSign adapter. The reconcile callback
 * checks the gateway folderStatus; fromJournal() uses it on restart to settle
 * any plan stuck in "executing".
 * @param {string} [journalPath]
 * @returns {PlanStore<EsignPayload>}
 */
export function createEsignStore(journalPath) {
  return new PlanStore({
    planTtlMs: 5 * 60 * 1000, // 5 minutes — eSign sends should settle quickly
    audit: {
      record: (event) => {
        console.log(`[esign-audit] ${event.status} token=${event.planToken.slice(0, 8)}... tool=${event.tool}`);
        return undefined;
      },
    },
    journalPath,
    reconcile: async (planToken) => {
      const folderId = tokenToFolder.get(planToken);
      if (!folderId) {
        console.error(`[esign-adapter] no folderId for token ${planToken.slice(0, 8)}, cannot reconcile`);
        return "unknown";
      }
      const status = await checkFolderStatus(folderId);
      if (status === "SHARED") return "done";
      if (status === "DRAFT") return "not-done";
      return "unknown";
    },
    reconcileTimeoutMs: 10_000, // eSign status check is fast; 10s is generous
  });
}

// --- Public adapter API ------------------------------------------------------

/**
 * @typedef {Object} EsignPayload
 * @property {string} folderId
 * @property {string} folderName
 * @property {Array<{firstName: string, lastName: string, email: string}>} recipients
 */

/**
 * Create a draft folder and return a plan token. This is the reversible
 * step — the folder is created with sendNow:false and sits in DRAFT status.
 * The plan token is bound to the payload fingerprint and can be used to
 * execute the send later.
 * @param {PlanStore<EsignPayload>} store
 * @param {EsignPayload} payload
 * @param {Partial<import("../../safe-write-mcp-core/src/index.js").PlanCreateOptions>} [options]
 * @returns {Promise<{planToken: string, folderId: string} | {error: string, status?: number}>}
 */
export async function createEsignFolder(
  store,
  payload,
  options = {},
) {
  // Minimal one-page PDF as a placeholder document for the draft.
  // In production this would come from the Foxit MCP's assembly tools.
  const tinyPdf =
    "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAw" +
    "IG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8" +
    "PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXT4+CmVuZG9iagp0" +
    "cmFpbGVyCjw8L1Jvb3QgMSAwIFI+Pg==";

  // Call Foxit MCP to create the draft folder
  const createResult = await req(`${GATEWAY}/esign/api/v1/folders/createfolder`, {
    method: "POST",
    headers: gatewayHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      folderName: payload.folderName,
      inputType: "base64",
      base64FileString: [tinyPdf],
      fileNames: [`${payload.folderName}.pdf`],
      processTextTags: false,
      processAcroFields: false,
      sendNow: false,
      parties: payload.recipients.map((r, i) => ({
        firstName: r.firstName,
        lastName: r.lastName,
        emailId: r.email,
        permission: "FILL_FIELDS_AND_SIGN",
        sequence: i + 1,
      })),
    }),
  });

  const j = createResult.json;
  const folder = j?.folder;
  const folderId = folder?.folderId;

  if (!folderId || !createResult.ok) {
    return { error: "createfolder failed", status: createResult.status };
  }

  // Build plan create options
  const createOpts = {
    tool: "esign_send",
    reason: options.reason ?? "Agent proposed eSign send",
    callerId: options.callerId ?? "agent",
    previewCount: payload.recipients.length,
    dataDigest: null, // No row-set digest for eSign — fingerprint is the binding
    extra: { folderId, folderName: payload.folderName },
    alwaysRequireApproval: true, // eSign is irreversible — always gate
    ...options,
  };

  const created = store.create(payload, createOpts);

  // Map token → folderId for reconcile
  tokenToFolder.set(created.planToken, folderId);

  return { planToken: created.planToken, folderId };
}

/**
 * Begin the eSign send — transitions the plan to "executing". The host
 * calls sendDraftFolder() next, then confirms with confirmEsignExecuted() or
 * confirmEsignFailed().
 * @param {PlanStore<EsignPayload>} store
 * @param {string} planToken
 * @returns {{ok: true, planToken: string} | {ok: false, error: string, code?: string}}
 */
export function beginEsignSend(
  store,
  planToken,
) {
  const payload = store.listPending().find((p) => p.planToken === planToken)?.payload
    ?? store.listExecuting().find((p) => p.planToken === planToken)?.payload;

  if (!payload) {
    // Reconstruct from the best-effort journal record if available
    return { ok: false, error: "payload not found — store may need fromJournal()" };
  }

  const result = store.beginExecute(planToken, payload);
  if (!result.ok) {
    return { ok: false, error: result.error.message, code: result.error.code };
  }
  return { ok: true, planToken };
}

/**
 * Confirm the eSign send succeeded. Marks the plan used and audits "executed".
 * @param {PlanStore<EsignPayload>} store
 * @param {string} planToken
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function confirmEsignExecuted(
  store,
  planToken,
) {
  const result = await store.confirmExecuted(planToken);
  if (!result.ok && result.error) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true };
}

/**
 * Confirm the eSign send failed. Releases the plan back to retryable.
 * @param {PlanStore<EsignPayload>} store
 * @param {string} planToken
 * @param {string} [reason]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function confirmEsignFailed(
  store,
  planToken,
  reason,
) {
  const result = await store.confirmFailed(planToken);
  if (!result.ok && result.error) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true };
}

/**
 * Reconcile a stuck-executing plan. Asks the gateway whether the send happened.
 * @param {PlanStore<EsignPayload>} store
 * @param {string} planToken
 * @returns {Promise<{outcome: string}>}
 */
export async function reconcileEsignPlan(
  store,
  planToken,
) {
  const result = await store.reconcileStuck(planToken);
  if (!result.ok && result.error) {
    return { outcome: result.error.code };
  }
  return { outcome: "settled" };
}

/**
 * List plans currently stuck in "executing" — useful for a health check
 * endpoint or restart recovery UI.
 * @param {PlanStore<EsignPayload>} store
 * @returns {Array}
 */
export function listExecutingPlans(store) {
  return store.listExecuting();
}

// --- helpers -----------------------------------------------------------------

/** @param {string} token */
function planTokenSlice(token) {
  return token.slice(0, 8);
}

// --- webhook handler ---------------------------------------------------------

/**
 * Handle an incoming eSign webhook event. Deduplicates on (folderId, event_name)
 * so the same event firing twice (gateway retries) does not cause a double-
 * processing. Returns true if the event was new, false if it was a duplicate.
 * @param {string} folderId
 * @param {string} eventName
 * @returns {boolean}
 */
export function handleWebhookEvent(folderId, eventName) {
  if (hasProcessedWebhook(folderId, eventName)) {
    return false;
  }
  markWebhookProcessed(folderId, eventName);
  return true;
}

// Re-export of PlanStore for convenience
export { PlanStore };
