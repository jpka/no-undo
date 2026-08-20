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
 * seen pairs to avoid double-handling.
 *
 * Gate 0 fixtures (docs/fixtures/esign-probe-aug18.txt) are the test replay
 * source — these tests do NOT call the live API.
 */

import { PlanStore, FileJournal } from "../../safe-write-mcp-core/dist/index.js";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const GATEWAY = process.env.FOXIT_ESIGN_HOST ?? "https://na1.fusion.foxit.com";
const LEGACY = process.env.FOXIT_ESIGN_LEGACY_HOST ?? "https://na1.foxitesign.foxit.com";

// --- HTTPS enforcement (CodeRabbit finding #4) --------------------------
// A non-HTTPS gateway would leak client_secret in cleartext. Fail fast at
// module load so a misconfigured env never sends credentials over HTTP.
for (const [name, url] of [
  ["FOXIT_ESIGN_HOST", GATEWAY],
  ["FOXIT_ESIGN_LEGACY_HOST", LEGACY],
]) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      console.error(`[esign-adapter] ${name} must use HTTPS, got: ${url}`);
      process.exit(1);
    }
  } catch {
    console.error(`[esign-adapter] ${name} is not a valid URL: ${url}`);
    process.exit(1);
  }
}

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
 * @returns {Promise<{ok: boolean, status: number, text: string, json: any, ms: number, transportError: boolean}>}
 */
async function req(url, init = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      redirect: "error", // don't follow redirects — could leak credentials to untrusted hosts
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return {
      ok: res.ok,
      status: res.status,
      text,
      json,
      ms: Date.now() - started,
      transportError: false,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: String(err),
      json: undefined,
      ms: Date.now() - started,
      transportError: true,
    };
  }
}

// --- Durable stores (CodeRabbit findings #1 and #2) ---------------------
// Both the tokenToFolder lookup and the webhook dedup Set were process-local
// in PR #5 — lost on restart. We back them with JSON files alongside the
// journal so a restarted process can still reconcile stuck plans and dedup
// gateway retry events.

class DurableStore {
  /** @param {string} path */
  constructor(path) {
    this.path = path;
    this.data = new Map();
    this.load();
  }

  load() {
    try {
      const raw = readFileSync(this.path, "utf8");
      const obj = JSON.parse(raw);
      this.data = new Map(Object.entries(obj));
    } catch (err) {
      // Only treat a missing file as empty initial state. Malformed existing
      // state is propagated so a corrupt file isn't silently replaced.
      if (err.code === "ENOENT") {
        this.data = new Map();
      } else {
        throw err;
      }
    }
  }

  save() {
    const obj = Object.fromEntries(this.data);
    const serialized = JSON.stringify(obj, null, 2);
    // Atomic write: write to a temp file in the same directory, then rename.
    // A crash mid-write can't corrupt the existing file.
    const tmpPath = `${this.path}.tmp`;
    try {
      writeFileSync(tmpPath, serialized, "utf8");
      renameSync(tmpPath, this.path);
    } catch (err) {
      // Clean up temp file on failure
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore cleanup errors
      }
      throw err;
    }
  }

  /** @param {string} key */
  get(key) {
    return this.data.get(key);
  }

  /** @param {string} key @param {unknown} value */
  set(key, value) {
    const hadValue = this.data.has(key);
    const previousValue = this.data.get(key);
    this.data.set(key, value);
    try {
      this.save();
    } catch (err) {
      // Roll back the in-memory mutation on persistence failure so the
      // durable state and in-memory state stay consistent.
      if (hadValue) this.data.set(key, previousValue);
      else this.data.delete(key);
      throw err;
    }
  }

  /** @param {string} key */
  has(key) {
    return this.data.has(key);
  }

  /** @param {string} key */
  delete(key) {
    const previousValue = this.data.get(key);
    const hadValue = this.data.has(key);
    const result = this.data.delete(key);
    try {
      this.save();
    } catch (err) {
      // Roll back the in-memory mutation on persistence failure.
      if (hadValue) this.data.set(key, previousValue);
      throw err;
    }
    return result;
  }
}

// Module-level durable stores — initialized by createEsignStore / loadEsignStore.
let tokenToFolder = null;
let processedEvents = null;

/**
 * Initialize durable stores alongside the journal file.
 * @param {string} journalPath
 */
function initDurableStores(journalPath) {
  if (!journalPath) return;
  const baseDir = dirname(journalPath);
  tokenToFolder = new DurableStore(join(baseDir, ".token-map.json"));
  processedEvents = new DurableStore(join(baseDir, ".webhook-dedup.json"));
}

// --- Webhook dedup ----------------------------------------------------------
// Gateway fires events on (folderId, event_name). A SHARED status means the
// folder was sent. We track processed pairs to avoid double-handling.

/** @param {string} folderId */
/** @param {string} eventName */
function webhookKey(folderId, eventName) {
  return `${folderId}:${eventName}`;
}

/** @param {string} folderId */
/** @param {string} eventName */
function hasProcessedWebhook(folderId, eventName) {
  return processedEvents?.has(webhookKey(folderId, eventName)) ?? false;
}

/** @param {string} folderId */
/** @param {string} eventName */
function markWebhookProcessed(folderId, eventName) {
  processedEvents?.set(webhookKey(folderId, eventName), true);
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
 * @returns {Promise<{ok: boolean, status: number, transportError: boolean}>}
 */
export async function sendDraftFolder(folderId) {
  const r = await req(`${GATEWAY}/esign/api/v1/folders/sendDraftFolder`, {
    method: "POST",
    headers: gatewayHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ folderId }),
  });
  return { ok: r.ok && r.status === 200, status: r.status, transportError: r.transportError };
}

// --- Plan store with reconcile ----------------------------------------------

/**
 * Create a PlanStore configured for the eSign adapter. The reconcile callback
 * checks the gateway folderStatus; the core's restoreFromJournal() replays the
 * journal on construction and restores any plan stuck in "executing".
 * @param {string} [journalPath]
 * @returns {PlanStore<EsignPayload>}
 */
export function createEsignStore(journalPath) {
  initDurableStores(journalPath);
  const journal = journalPath ? new FileJournal(journalPath) : undefined;
  return new PlanStore({
    planTtlMs: 5 * 60 * 1000, // 5 minutes — eSign sends should settle quickly
    audit: {
      record: (event) => {
        console.log(
          `[esign-audit] ${event.status} token=${event.planToken.slice(0, 8)}... tool=${event.tool}`,
        );
        return undefined;
      },
    },
    journal,
    reconcile: async (planToken) => {
      const folderId = tokenToFolder?.get(planToken);
      if (!folderId) {
        console.error(
          `[esign-adapter] no folderId for token ${planToken.slice(0, 8)}, cannot reconcile`,
        );
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

/**
 * Load a PlanStore from a journal file for restart recovery. Replays the
 * journal, hydrates durable tokenToFolder and processedEvents stores, and
 * reconciles any stuck-executing plans.
 * @param {string} journalPath
 * @param {Partial<import("../../safe-write-mcp-core/dist/index.js").PlanStoreOptions>} [options]
 * @returns {Promise<PlanStore<EsignPayload>>}
 */
export async function loadEsignStore(journalPath, options = {}) {
  initDurableStores(journalPath);
  // Preload tokenToFolder from the journal's stored extra.folderId before
  // reconciliation. If .token-map.json was lost, the journal is the
  // authoritative source.
  preloadTokenMapFromJournal(journalPath);
  // Create a store — the core replays the journal on construction and
  // restores executing plans.
  const store = new PlanStore({
    ...options,
    journal: new FileJournal(journalPath),
    reconcile: async (planToken) => {
      const folderId = tokenToFolder?.get(planToken);
      if (!folderId) {
        console.error(
          `[esign-adapter] no folderId for token ${planToken.slice(0, 8)}, cannot reconcile`,
        );
        return "unknown";
      }
      const status = await checkFolderStatus(folderId);
      if (status === "SHARED") return "done";
      if (status === "DRAFT") return "not-done";
      return "unknown";
    },
    reconcileTimeoutMs: options.reconcileTimeoutMs ?? 10_000,
  });
  // Rebuild tokenToFolder from recovered executing plans' extra.folderId as a
  // fallback — if the durable store file was lost, the journal's extra field
  // is the authoritative source for folderId mappings.
  if (tokenToFolder) {
    for (const plan of store.listExecuting()) {
      const folderId = plan.extra?.folderId;
      if (folderId && !tokenToFolder.has(plan.planToken)) {
        tokenToFolder.set(plan.planToken, folderId);
      }
    }
  }
  return store;
}

/**
 * Preload tokenToFolder from journal records' extra.folderId. The journal stores
 * the full PlanMeta (including extra) on every transition, so even if
 * .token-map.json was deleted, we can rebuild the mapping for reconciliation.
 * @param {string} journalPath
 */
function preloadTokenMapFromJournal(journalPath) {
  if (!tokenToFolder) return;
  try {
    const raw = readFileSync(journalPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const folderId = rec.extra?.folderId;
        if (folderId && rec.planToken && !tokenToFolder.has(rec.planToken)) {
          tokenToFolder.set(rec.planToken, folderId);
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // journal missing or unreadable — reconcile will return "unknown"
  }
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
 * @param {Partial<import("../../safe-write-mcp-core/dist/index.js").PlanCreateOptions>} [options]
 * @returns {Promise<{planToken: string, folderId: string} | {error: string, status?: number}>}
 */
export async function createEsignFolder(store, payload, options = {}) {
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

  // Persist token → folderId in durable store (CodeRabbit finding #2)
  tokenToFolder?.set(created.planToken, folderId);

  return { planToken: created.planToken, folderId };
}

/**
 * Begin the eSign send — transitions the plan to "executing". The host
 * calls sendDraftFolder() next, then confirms with confirmEsignExecuted() or
 * confirmFailed().
 *
 * The payload MUST be provided. After a crash, the core's journal replay
 * cannot reconstruct the original payload (only the fingerprint), so the
 * host must re-create it. The core's beginExecute() will reject a mismatched
 * fingerprint.
 * @param {PlanStore<EsignPayload>} store
 * @param {string} planToken
 * @param {EsignPayload} payload
 * @returns {{ok: true, planToken: string} | {ok: false, error: string, code?: string}}
 */
export function beginEsignSend(store, planToken, payload) {
  if (!payload) {
    return { ok: false, error: "payload is required for beginEsignSend" };
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
export async function confirmEsignExecuted(store, planToken) {
  const result = await store.confirmExecuted(planToken);
  if (!result.ok && result.error) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true };
}

/**
 * Confirm the eSign send failed. Releases the plan back to retryable.
 *
 * CodeRabbit finding #3: Before releasing, verify the send actually failed by
 * checking the gateway folderStatus. If the folder is SHARED, the send
 * succeeded and we must NOT release the plan — that would allow a duplicate
 * send on retry. If the status is unknown (null), retain the executing state
 * for reconciliation instead of guessing.
 * @param {PlanStore<EsignPayload>} store
 * @param {string} planToken
 * @param {string} [reason]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function confirmEsignFailed(store, planToken, reason) {
  const folderId = tokenToFolder?.get(planToken);
  if (!folderId) {
    // No mapping — can't verify send status. Retain executing for reconciliation.
    return { ok: false, error: "no folderId mapping — plan retained for reconciliation" };
  }
  const status = await checkFolderStatus(folderId);
  if (status === "SHARED") {
    // The send actually succeeded — releasing would allow a duplicate send.
    return { ok: false, error: "folder status is SHARED — send succeeded, use confirmEsignExecuted" };
  }
  if (status === null) {
    // Unknown outcome — retain executing state for reconciliation.
    return { ok: false, error: "folder status unknown — plan retained for reconciliation" };
  }
  // status === "DRAFT": send truly failed, safe to release.
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
export async function reconcileEsignPlan(store, planToken) {
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
 *
 * CodeRabbit finding #1: dedup is now durable across restarts via processedEvents
 * DurableStore.
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
