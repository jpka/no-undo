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

import { PlanStore } from "safe-write-mcp-core";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  compositeSink,
  createJsonlAuditSink,
  defaultAuditPath,
} from "../lib/jsonl-audit-sink.mjs";
import {
  assemblePdf as defaultAssemblePdf,
  TINY_PDF_BASE64 as fallbackPdfBase64,
  TINY_PDF_SHA256 as fallbackPdfSha256,
  sha256Base64,
} from "./pdf-assembly.mjs";

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

/** @returns {Record<string, string>} */
function gatewayHeaders(extra = {}) {
  const clientId = process.env.FOXIT_CLOUD_API_CLIENT_ID ?? process.env.FOXIT_CLIENT_ID;
  const clientSecret =
    process.env.FOXIT_CLOUD_API_CLIENT_SECRET ?? process.env.FOXIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "[esign-adapter] missing credentials: set FOXIT_CLIENT_ID and FOXIT_CLIENT_SECRET",
    );
  }

  return { client_id: clientId, client_secret: clientSecret, ...extra };
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs=30_000]
 * @returns {Promise<{ok: boolean, status: number, text: string, json: any, ms: number, transportError: boolean}>}
 */
async function req(url, init = {}, timeoutMs = 30_000) {
  const started = Date.now();
  // Merge caller's signal (if any) with our timeout — caller's signal wins if already aborted
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
  const { signal: _ignored, ...restInit } = init;
  try {
    const res = await fetch(url, {
      ...restInit,
      signal,
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
let pollState = null;

/**
 * Initialize durable stores alongside the journal file.
 * @param {string} journalPath
 */
function initDurableStores(journalPath) {
  if (!journalPath) return;
  const baseDir = dirname(journalPath);
  tokenToFolder = new DurableStore(join(baseDir, ".token-map.json"));
  processedEvents = new DurableStore(join(baseDir, ".webhook-dedup.json"));
  pollState = new DurableStore(join(baseDir, ".poll-state.json"));
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
 *   - "EXECUTED" → all required signing completed and digital signatures applied (terminal, signed)
 *   - "SHARED" → the folder was sent for signature (sent, not yet signed — see Foxit Aug 27 contact)
 *   - "DRAFT" → the folder is still a draft (side effect did NOT happen)
 *   - null → could not determine (unknown / transport error)
 * Per Aug 27 Foxit contact §4a: EXECUTED is the only terminal signed state;
 * SHARED, folder_completed and the signing redirect must NOT be treated as signed.
 * @param {string} folderId
 * @returns {Promise<string|null>}
 */
export async function checkFolderStatus(folderId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const r = await req(
    `${GATEWAY}/esign/api/v1/folders/myfolder?folderId=${encodeURIComponent(folderId)}`,
    { headers: gatewayHeaders() },
    timeoutMs,
  );
  if (!r.ok) return null;
  const j = r.json;
  const folder = j?.folder;
  const status = folder?.folderStatus;
  return typeof status === "string" ? status : null;
}

/**
 * Returns true iff the given folderStatus represents a signed, fully-executed
 * envelope. Only EXECUTED counts — SHARED means sent, not signed.
 * @param {string|null} status
 * @returns {boolean}
 */
export function isExecutedStatus(status) {
  return status === "EXECUTED";
}

/**
 * Returns true iff the given folderStatus represents a sent envelope (SHARED
 * or EXECUTED). EXECUTED implies sent, so callers that only care about
 * "did the send happen" (idempotency / reconcile) treat both as done.
 * @param {string|null} status
 * @returns {boolean}
 */
export function isSentStatus(status) {
  return status === "SHARED" || status === "EXECUTED";
}

// --- Signed-document download ------------------------------------------------

/**
 * Download the signed PDF bytes for a folder that has reached EXECUTED.
 * Two routes, per Foxit Aug 27 contact:
 *   1. Single document: GET /esign/api/v1/folders/document/download?folderId=&docNumber=
 *   2. Full envelope : GET /esign/api/v1/folders/download?folderId=
 * Both are binary responses (PDF bytes), not JSON.
 * This helper hits (1) when docNumber is provided and (2) otherwise.
 * @param {string} folderId
 * @param {{docNumber?: number|string|null, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, status: number, bytes?: Uint8Array, transportError: boolean, text?: string}>}
 */
export async function downloadSignedDocument(folderId, options = {}) {
  const docNumber = options.docNumber ?? null;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const url =
    docNumber === null || docNumber === undefined
      ? `${GATEWAY}/esign/api/v1/folders/download?folderId=${encodeURIComponent(folderId)}`
      : `${GATEWAY}/esign/api/v1/folders/document/download?folderId=${encodeURIComponent(folderId)}&docNumber=${encodeURIComponent(String(docNumber))}`;
  try {
    const res = await fetch(url, {
      headers: gatewayHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, transportError: false, text };
    }
    const buf = await res.arrayBuffer();
    return { ok: true, status: res.status, bytes: new Uint8Array(buf), transportError: false };
  } catch (err) {
    return { ok: false, status: 0, transportError: true, text: String(err) };
  }
}

/**
 * Convenience wrapper for single-document download route (explicit docNumber).
 * @param {string} folderId
 * @param {number|string} docNumber
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, status: number, bytes?: Uint8Array, transportError: boolean, text?: string}>}
 */
export async function downloadSingleDocument(folderId, docNumber, options = {}) {
  return downloadSignedDocument(folderId, { ...options, docNumber });
}

/**
 * Convenience wrapper for full-envelope download route (no docNumber).
 * @param {string} folderId
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, status: number, bytes?: Uint8Array, transportError: boolean, text?: string}>}
 */
export async function downloadEnvelope(folderId, options = {}) {
  return downloadSignedDocument(folderId, { ...options, docNumber: null });
}

// --- Polling for signed state ------------------------------------------------

/**
 * Poll `GET /esign/api/v1/folders/myfolder?folderId=` with bounded backoff
 * until `folderStatus === "EXECUTED"`, then return. Persists the last
 * observed status in the durable `.poll-state.json` so a restart mid-poll
 * can resume without re-sending.
 *
 * Transport errors and non-EXECUTED statuses are treated as "keep polling"
 * until the deadline. Only EXECUTED is terminal; SHARED/DRAFT/null all
 * continue polling. This matches the Foxit Aug 27 guidance: poll-until-EXECUTED
 * with a timeout, not poll-until-SHARED.
 *
 * @param {string} folderId
 * @param {{timeoutMs?: number, intervalMs?: number}} [options] - timeoutMs defaults to 30s, intervalMs to 2000ms
 * @returns {Promise<{status: string|null, executed: boolean, attempts: number, elapsedMs: number}>}
 */
export async function pollUntilSigned(folderId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 2000;
  const started = Date.now();
  const deadline = started + timeoutMs;
  let attempts = 0;
  let lastStatus = null;

  while (Date.now() < deadline) {
    attempts += 1;
    const remainingForReq = Math.max(500, deadline - Date.now());
    // Bound the network request to the remaining poll budget so a stalled
    // gateway call cannot overrun the caller's --poll-timeout by 30s.
    const status = await checkFolderStatus(folderId, { timeoutMs: Math.min(30_000, remainingForReq) });
    lastStatus = status;
    try {
      pollState?.set(folderId, { status, updatedAt: new Date().toISOString(), attempts });
    } catch {
      // pollState persistence is best-effort; polling continues even if it fails
    }
    if (status === "EXECUTED") {
      return { status, executed: true, attempts, elapsedMs: Date.now() - started };
    }
    const now = Date.now();
    const remaining = deadline - now;
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
  return { status: lastStatus, executed: false, attempts, elapsedMs: Date.now() - started };
}

/**
 * Read the last observed poll status for a folder from durable state.
 * @param {string} folderId
 * @returns {{status: string|null, updatedAt?: string, attempts?: number}|null}
 */
export function getPollState(folderId) {
  return pollState?.get(folderId) ?? null;
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
 * The audit sink, shared by both store constructors.
 *
 * Two channels: a stderr console line a human watches in the terminal, and a
 * hash-chained append-only JSONL file beside the journal (prevHash + sha256
 * per record — see mcp/lib/jsonl-audit-sink.mjs).
 *
 * stderr, NOT stdout: this module runs inside an MCP server whose stdout
 * carries the JSON-RPC stream. The previous sink used console.log here — an
 * interleaved plain-text line that an MCP client reading stdout line-by-line
 * hits as a parse error, corrupting the session. Every diagnostic in this
 * project goes to stderr for the same reason.
 *
 * @param {string | null} auditPath  null keeps console-only auditing
 */
function makeEsignAuditSink(auditPath) {
  const consoleSink = {
    record: (event) => {
      console.error(
        `[esign-audit] ${event.status} token=${event.planToken.slice(0, 8)}... tool=${event.tool}`,
      );
      return undefined;
    },
  };
  if (!auditPath) return consoleSink;
  return compositeSink(consoleSink, createJsonlAuditSink(auditPath));
}

/**
 * Create a PlanStore configured for the eSign adapter. The reconcile callback
 * checks the gateway folderStatus; the core's restoreFromJournal() replays the
 * journal on construction and restores any plan stuck in "executing".
 *
 * Audit events go to stderr plus a hash-chained JSONL file. The path defaults
 * to `<journalDir>/esign-audit.jsonl` and can be overridden with
 * `NO_UNDO_ESIGN_AUDIT_PATH` or the `auditPath` option; pass `auditPath: null`
 * to keep console-only auditing.
 * @param {string} [journalPath]
 * @param {{auditPath?: string | null}} [options]
 * @returns {PlanStore<EsignPayload>}
 */
export function createEsignStore(journalPath, options = {}) {
  initDurableStores(journalPath);
  const auditPath = defaultAuditPath(
    journalPath,
    "esign",
    "auditPath" in options ? options.auditPath : process.env.NO_UNDO_ESIGN_AUDIT_PATH,
  );
  return new PlanStore({
    planTtlMs: 5 * 60 * 1000,
    audit: makeEsignAuditSink(auditPath),
    journalPath,
    reconcile: async (planToken) => {
      const folderId = tokenToFolder?.get(planToken);
      if (!folderId) return "unknown";
      const status = await checkFolderStatus(folderId);
      if (isSentStatus(status)) return "done";
      if (status === "DRAFT") return "not-done";
      return "unknown";
    },
  });
}

/**
 * Load a PlanStore from a journal file for restart recovery. Replays the
 * journal, hydrates durable tokenToFolder and processedEvents stores, and
 * reconciles any stuck-executing plans.
 * @param {string} journalPath
 * @param {Partial<import("safe-write-mcp-core").PlanStoreOptions>} [options]
 * @returns {Promise<PlanStore<EsignPayload>>}
 */
export async function loadEsignStore(journalPath, options = {}) {
  initDurableStores(journalPath);
  preloadTokenMapFromJournal(journalPath);
  const auditPath = defaultAuditPath(
    journalPath,
    "esign",
    "auditPath" in options ? options.auditPath : process.env.NO_UNDO_ESIGN_AUDIT_PATH,
  );
  const store = await PlanStore.fromJournal(journalPath, {
    ...options,
    journalPath,
    audit: makeEsignAuditSink(auditPath),
    reconcile: async (planToken) => {
      const folderId = tokenToFolder?.get(planToken);
      if (!folderId) return "unknown";
      const status = await checkFolderStatus(folderId);
      if (isSentStatus(status)) return "done";
      if (status === "DRAFT") return "not-done";
      return "unknown";
    },
  });
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
 * @param {Partial<import("safe-write-mcp-core").PlanCreateOptions>} [options]
 * @returns {Promise<{planToken: string, folderId: string} | {error: string, status?: number}>}
 */
export async function createEsignFolder(store, payload, options = {}) {
  // Foxit PDF assembly: render HTML → pdf_from_html → get_task_result
  // (B: real Foxit PDF wiring). Falls back to deterministic tiny PDF so CI
  // without credentials stays green — the SHA-256 remains inspectable in the
  // approval card via extra.documentSha256.
  const assemble = options.assemblePdf ?? defaultAssemblePdf;
  let pdfBase64 = fallbackPdfBase64;
  let pdfSha256 = fallbackPdfSha256;
  let pdfVia = "fixture";
  try {
    const assembled = await assemble(payload, {
      html: options.pdfHtml ?? undefined,
      timeoutMs: options.pdfTimeoutMs ?? undefined,
    });
    if (assembled?.base64) {
      // Validate base64 and compute digest before accepting bytes — prevents
      // pairing invalid payload with fixture digest (Greptile P1)
      const computedSha = sha256Base64(assembled.base64);
      pdfBase64 = assembled.base64;
      pdfSha256 = computedSha;
      pdfVia = assembled.via ?? "foxit-mcp";
    }
  } catch (e) {
    // Fixture mode (NO_FOXIT_MCP or missing creds) already returns fixture without throwing.
    // Live credentials + MCP failure should fail closed — don't silently send wrong doc.
    const forceFixture =
      process.env.NO_FOXIT_MCP === "1" ||
      process.env.FOXIT_PDF_FIXTURE === "1" ||
      process.env.FOXIT_PDF_FORCE_MCP === "0";
    const hasCreds = Boolean(
      (process.env.FOXIT_CLIENT_ID && process.env.FOXIT_CLIENT_SECRET) ||
        (process.env.FOXIT_CLOUD_API_CLIENT_ID && process.env.FOXIT_CLOUD_API_CLIENT_SECRET)
    );
    if (forceFixture || !hasCreds) {
      console.error(`[esign-adapter] PDF assembly threw — using fixture: ${e instanceof Error ? e.message : String(e)}`);
    } else {
      console.error(`[esign-adapter] PDF assembly failed (live creds): ${e instanceof Error ? e.message : String(e)}`);
      return { error: `pdf assembly failed: ${e instanceof Error ? e.message : String(e)}`, status: 0 };
    }
  }
  // Call Foxit eSign to create the draft folder
  const createResult = await req(`${GATEWAY}/esign/api/v1/folders/createfolder`, {
    method: "POST",
    headers: gatewayHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      folderName: payload.folderName,
      inputType: "base64",
      base64FileString: [pdfBase64],
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

  // Build plan create options — extra carries the Foxit-assembled document's
  // SHA-256 for the gate's digest line (build-plan step 3: pdf_from_html bytes
  // → base64FileString + extra.documentSha256). Always wins over any caller-
  // supplied extra.documentSha256 so the digest matches the bytes actually sent.
  // Caller cannot override digest — single clean definition after spread.
  const extra = {
    folderId,
    folderName: payload.folderName,
    ...(options.extra ?? {}),
    documentSha256: pdfSha256,
    documentVia: pdfVia,
  };
  const { extra: _extraIgnored, ...restOptions } = options;
  const createOpts = {
    tool: "esign_send",
    reason: options.reason ?? "Agent proposed eSign send",
    callerId: options.callerId ?? "agent",
    previewCount: payload.recipients.length,
    dataDigest: null, // No row-set digest for eSign — fingerprint is the binding
    extra,
    alwaysRequireApproval: true, // eSign is irreversible — always gate
    ...restOptions,
    extra, // ensure caller cannot override the digest
  };

  const created = store.create(payload, createOpts);

  // Persist token → folderId in durable store (CodeRabbit finding #2)
  tokenToFolder?.set(created.planToken, folderId);

  return { planToken: created.planToken, folderId };
}

/**
 * Deterministic crash injection for the demo and its tests.
 *
 * The money shot — "the process dies between the journal fsync and the send"
 * — is not reproducible by hand-timing kill -9. When
 * NO_UNDO_CRASH_AFTER_FSYNC is set to "1" (any plan) or to a specific plan
 * token, this SIGKILLs the process at exactly that boundary: after
 * store.beginExecute() has fsync'd "executing" to the journal, before the
 * gateway call goes out. On restart, journal replay finds the stuck plan and
 * reconcile decides Branch A (DRAFT → retry, no double-send) or Branch B
 * (SHARED → record executed, send exactly once).
 *
 * Exported so tests can spawn a child process that exercises it without the
 * MCP server or network. Returns true if it killed the process; unreachable,
 * but keeps the function honest for direct calls.
 * @param {string} planToken
 * @returns {boolean}
 */
export function maybeCrashAfterFsync(planToken) {
  if (process.env.NODE_ENV === "production") {
    process.stderr.write(
      "[crash-injection] ignored: NODE_ENV=production refuses crash injection\n",
    );
    return false;
  }
  const flag = process.env.NO_UNDO_CRASH_AFTER_FSYNC;
  if (!flag) return false;
  if (flag !== "1" && flag !== planToken) return false;
  process.stderr.write(
    `[crash-injection] NO_UNDO_CRASH_AFTER_FSYNC set — SIGKILL after beginExecute fsync ` +
      `(token=${planToken.slice(0, 8)}...) before the gateway send\n`,
  );
  process.kill(process.pid, "SIGKILL");
  return true;
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
 *
 * Crash injection sits exactly here: beginExecute has made "executing"
 * durable; nothing irreversible has happened yet.
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
  maybeCrashAfterFsync(planToken);
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
  if (isSentStatus(status)) {
    // The send actually succeeded (SHARED or EXECUTED) — releasing would allow a duplicate send.
    return { ok: false, error: `folder status is ${status} — send succeeded, use confirmEsignExecuted` };
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
