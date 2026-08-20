/**
 * Nutrient DWS Processor redaction adapter — consumes safe-write-mcp-core.
 *
 * Nutrient's redaction flow splits cleanly along the same seam this whole
 * project is built on:
 *
 *   createRedactions  — STAGE. Marks regions as redaction annotations. The
 *                       underlying content is still there; the marks can be
 *                       removed. Reversible, so it runs unattended.
 *   applyRedactions   — APPLY. Burns the marks in and destroys the covered
 *                       content permanently. Irreversible, so it is gated on
 *                       human approval exactly like the eSign send.
 *
 * That is the design argument for the submission: one approval surface reviews
 * both irreversible actions, because the property that makes them dangerous is
 * the same property in both cases.
 *
 * WHAT THIS CANNOT DO, AND WHY THAT IS WRITTEN DOWN RATHER THAN HIDDEN
 * -------------------------------------------------------------------
 * The eSign adapter can reconcile a crashed send: it asks the gateway whether
 * the folder is DRAFT or SHARED and gets a real answer. `/build` has no
 * equivalent. It is a single synchronous request that returns a PDF; there is
 * no job id, no server-side state, nothing to query after the fact. So a
 * process that dies mid-apply cannot be reconciled server-side, and `reconcile`
 * here returns "unknown" — honestly — rather than guessing. The plan stays
 * visibly stuck in `executing` and queryable via `listExecutingRedactions()`,
 * which is the safe direction: a human decides, and the audit log does not
 * claim something it cannot know. An audit trail that lies is the failure mode
 * this project exists to prevent, so a convenient fake reconciliation would
 * defeat the point.
 *
 * Dedup is therefore ours alone. `/build` accepts an `Idempotency-Key` only
 * together with `Prefer: respond-async`; on the synchronous path there is no
 * server-side dedup at all. The per-operation digest (document SHA-256 plus the
 * canonical serialized instructions) is both the dedup key and the core's
 * `dataDigest`, which makes `beginExecute()` fail closed with
 * DATA_DIGEST_MISMATCH if the document changed between staging and applying.
 * That TOCTOU check is the point: the document content is the entire risk
 * surface, so binding the plan to a name or an id would not be binding it to
 * anything that matters.
 */

import { PlanStore } from "safe-write-mcp-core";
import { createHash } from "node:crypto";

const BUILD_URL = process.env.NUTRIENT_BUILD_URL ?? "https://api.nutrient.io/build";

// A non-HTTPS endpoint would put the API key and the document on the wire in
// cleartext. Fail at module load so a misconfigured env cannot leak either.
{
  let parsed;
  try {
    parsed = new URL(BUILD_URL);
  } catch {
    throw new Error(`[redaction-adapter] NUTRIENT_BUILD_URL is not a valid URL: ${BUILD_URL}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`[redaction-adapter] NUTRIENT_BUILD_URL must use HTTPS, got: ${BUILD_URL}`);
  }
}

/**
 * Read the Processor credential lazily.
 *
 * Deliberately not checked at module load: tests import this module without
 * credentials, and exiting on import would make it untestable. Note this is the
 * DWS Processor key, a different product from the Data Extraction key the
 * extraction adapter uses — the same account carries both and they are not
 * interchangeable.
 * @returns {string}
 */
function apiKey() {
  const key = process.env.NUTRIENT_API_KEY;
  if (!key) {
    throw new Error(
      "[redaction-adapter] missing credentials: set NUTRIENT_API_KEY (the DWS Processor key)",
    );
  }
  return key;
}

// --- HTTP -------------------------------------------------------------------

/**
 * POST to /build. Returns a structured result rather than throwing, so callers
 * can distinguish a transport failure from a rejection — the difference decides
 * whether a retry is safe.
 * @param {FormData} body
 * @returns {Promise<{ok: boolean, status: number, bytes: Uint8Array|null, errorText: string|null, ms: number, transportError: boolean}>}
 */
async function postBuild(body) {
  const started = Date.now();
  try {
    const res = await fetch(BUILD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}` },
      body,
      signal: AbortSignal.timeout(120_000),
      redirect: "error", // never replay a credentialed document upload onto a redirect target
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        bytes: null,
        errorText: await res.text(),
        ms,
        transportError: false,
      };
    }
    // A successful /build returns the resulting PDF as binary, not JSON.
    const buf = new Uint8Array(await res.arrayBuffer());
    return { ok: true, status: res.status, bytes: buf, errorText: null, ms, transportError: false };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      bytes: null,
      errorText: String(err),
      ms: Date.now() - started,
      transportError: true,
    };
  }
}

// --- Redaction targets ------------------------------------------------------

/**
 * @typedef {{strategy: "text", text: string, caseSensitive?: boolean, includeAnnotations?: boolean}
 *          |{strategy: "regex", regex: string, includeAnnotations?: boolean}
 *          |{strategy: "preset", preset: string, includeAnnotations?: boolean}} RedactionTarget
 */

/**
 * Preset identifiers confirmed against the live /build endpoint (Aug 20, 2026).
 *
 * Each of these returned 200. The obvious short forms do NOT work and return 400:
 * `email`, `phone`, `ssn`, `email_addresses`, `emailAddress`, `phone-number`, and
 * `us-social-security-number` were all rejected. The naming is inconsistent
 * enough to be worth pinning rather than guessing at call time — a typo here is
 * a 400 at best and a silently-unredacted document at worst, since a preset that
 * matches nothing stages zero regions and still returns a valid PDF.
 *
 * Not exhaustive: this is what was probed, not the complete vendor list.
 */
export const CONFIRMED_PRESETS = Object.freeze([
  "email-address",
  "social-security-number",
  "credit-card-number",
  "north-american-phone-number",
  "international-phone-number",
  "date",
  "time",
  "url",
  "ipv4",
  "ipv6",
  "vin",
]);

/**
 * Build the `createRedactions` actions for a target list.
 * @param {RedactionTarget[]} targets
 * @returns {Array<Record<string, unknown>>}
 */
function createRedactionActions(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("[redaction-adapter] at least one redaction target is required");
  }
  return targets.map((t) => {
    /** @type {Record<string, unknown>} */
    const strategyOptions = { includeAnnotations: t.includeAnnotations ?? true };
    if (t.strategy === "text") {
      if (!t.text) throw new Error("[redaction-adapter] text strategy requires `text`");
      strategyOptions.text = t.text;
      strategyOptions.caseSensitive = t.caseSensitive ?? false;
    } else if (t.strategy === "regex") {
      if (!t.regex) throw new Error("[redaction-adapter] regex strategy requires `regex`");
      strategyOptions.regex = t.regex;
    } else if (t.strategy === "preset") {
      if (!t.preset) throw new Error("[redaction-adapter] preset strategy requires `preset`");
      strategyOptions.preset = t.preset;
    } else {
      throw new Error(`[redaction-adapter] unknown redaction strategy: ${String(t.strategy)}`);
    }
    return { type: "createRedactions", strategy: t.strategy, strategyOptions };
  });
}

/**
 * Describe a target for the approval UI without echoing anything sensitive.
 *
 * A literal `text` target IS the sensitive value — redacting a named person means
 * the name is the search term — so it is described by shape and length only.
 *
 * A regex needs the same treatment for the same reason: `/Kaniefsky|555-01-0042/`
 * is a pattern that embeds exactly the values being hidden. Printing it in full
 * would put them on the review screen. So only the pattern's structure is
 * reported: length, and whether it contains literal word or digit runs long
 * enough to be a value rather than a character class. A preset is a category name
 * with no document content in it, which is safe to show and is what the reviewer
 * actually needs.
 * @param {RedactionTarget} t
 * @returns {string}
 */
export function describeTarget(t) {
  if (t.strategy === "preset") return `preset: ${t.preset}`;
  if (t.strategy === "regex") {
    const pattern = typeof t.regex === "string" ? t.regex : "";
    // Literal runs are the part that could be a value rather than a matcher.
    const hasLiterals = /[A-Za-z0-9]{4,}/.test(pattern);
    const shape = hasLiterals ? "contains literal runs" : "character classes only";
    return `regex (${pattern.length} chars, ${shape}) — pattern withheld from this view`;
  }
  const len = typeof t.text === "string" ? t.text.length : 0;
  const sensitivity = t.caseSensitive ? "case-sensitive" : "case-insensitive";
  return `literal text (${len} chars, ${sensitivity}) — value withheld from this view`;
}

/**
 * Canonical JSON with recursively sorted keys.
 *
 * The digest has to be stable across key insertion order, or a logically
 * identical instruction set staged twice would produce two different digests
 * and the dedup would silently never fire.
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  const parts = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * The per-operation digest: SHA-256 over the document bytes and the canonical
 * instruction set together.
 *
 * Both halves are load-bearing. The document alone would let a different
 * redaction set apply under an approved plan; the instructions alone would let a
 * swapped document be redacted under a plan approved for the original. Hashing
 * them jointly is what makes an approval specific to one operation on one
 * document.
 * @param {Uint8Array} documentBytes
 * @param {RedactionTarget[]} targets
 * @returns {string} hex digest
 */
export function operationDigest(documentBytes, targets) {
  const h = createHash("sha256");
  h.update(documentBytes);
  h.update("\u0000"); // separator so bytes cannot bleed into the instruction text
  h.update(canonicalJson(createRedactionActions(targets)));
  return h.digest("hex");
}

// --- Stage and apply --------------------------------------------------------

/**
 * Stage redactions: mark the regions, destroy nothing.
 *
 * Runs unattended because it is reversible — the returned PDF carries redaction
 * annotations over content that is still present and still recoverable. Sending
 * this document anywhere is not safe; it looks redacted and is not. Only
 * `applyRedactions` makes that true, and that is the gated step.
 * @param {Uint8Array} documentBytes
 * @param {RedactionTarget[]} targets
 * @param {{fileName?: string}} [options]
 * @returns {Promise<{ok: true, bytes: Uint8Array, digest: string, staged: {count: number, targets: string[]}, ms: number} | {ok: false, error: string, status: number, transportError: boolean}>}
 */
export async function stageRedactions(documentBytes, targets, options = {}) {
  const actions = createRedactionActions(targets);
  const body = new FormData();
  body.append(
    "document",
    new Blob([documentBytes]),
    options.fileName ?? "document.pdf",
  );
  body.append(
    "instructions",
    JSON.stringify({ parts: [{ file: "document" }], actions }),
  );

  const r = await postBuild(body);
  if (!r.ok) {
    return {
      ok: false,
      error: `stageRedactions failed: ${r.errorText ?? "unknown"}`,
      status: r.status,
      transportError: r.transportError,
    };
  }
  return {
    ok: true,
    bytes: r.bytes,
    // Digest the STAGED output, because that is the document the apply step will
    // act on. Digesting the original would leave the gap between stage and apply
    // unguarded, which is the gap that matters.
    digest: operationDigest(r.bytes, targets),
    staged: { count: actions.length, targets: targets.map(describeTarget) },
    ms: r.ms,
  };
}

/**
 * Apply redactions: the irreversible call. Content under every mark is
 * destroyed and cannot be recovered from the output.
 *
 * Nothing in this function enforces approval — that is the plan store's job via
 * `beginRedactionApply()`. Calling this directly bypasses the gate, which is why
 * the MCP server never exposes it as a standalone tool.
 * @param {Uint8Array} documentBytes
 * @param {RedactionTarget[]} targets
 * @param {{fileName?: string}} [options]
 * @returns {Promise<{ok: true, bytes: Uint8Array, ms: number} | {ok: false, error: string, status: number, transportError: boolean}>}
 */
export async function applyRedactions(documentBytes, targets, options = {}) {
  const actions = [...createRedactionActions(targets), { type: "applyRedactions" }];
  const body = new FormData();
  body.append("document", new Blob([documentBytes]), options.fileName ?? "document.pdf");
  body.append("instructions", JSON.stringify({ parts: [{ file: "document" }], actions }));

  const r = await postBuild(body);
  if (!r.ok) {
    return {
      ok: false,
      error: `applyRedactions failed: ${r.errorText ?? "unknown"}`,
      status: r.status,
      transportError: r.transportError,
    };
  }
  return { ok: true, bytes: r.bytes, ms: r.ms };
}

// --- Plan store -------------------------------------------------------------

/**
 * @typedef {Object} RedactionPayload
 * @property {string} documentName
 * @property {string} digest                 operationDigest of the staged document
 * @property {RedactionTarget[]} targets
 * @property {number} [stagedCount]
 */

/**
 * Create a PlanStore for redaction applies.
 *
 * The `reconcile` hook returns "unknown" unconditionally, and that is the
 * correct implementation rather than a placeholder. `/build` is synchronous with
 * no job handle: after a crash there is no server-side state to query, so
 * nothing can truthfully report whether the apply landed. Guessing "not-done"
 * would risk a second destructive apply; guessing "done" would mark a plan
 * executed that may never have run and put a false claim in the audit log. So
 * the plan stays in `executing`, `listExecutingRedactions()` surfaces it, and a
 * human resolves it. The audit log only ever says what is known.
 * @param {string} journalPath
 * @returns {PlanStore<RedactionPayload>}
 */
export function createRedactionStore(journalPath) {
  return new PlanStore({
    planTtlMs: 5 * 60 * 1000,
    journalPath,
    audit: {
      record: (event) => {
        console.log(
          `[redaction-audit] ${event.status} token=${event.planToken.slice(0, 8)}... tool=${event.tool}`,
        );
        return undefined;
      },
    },
    reconcile: async () => "unknown",
  });
}

/**
 * Load a redaction store from its journal after a restart.
 *
 * The core's constructor replays the journal, so any plan left mid-apply comes
 * back as `executing` and stays there — see the reconcile note above.
 * @param {string} journalPath
 * @param {Partial<import("safe-write-mcp-core").PlanStoreOptions>} [options]
 * @returns {Promise<PlanStore<RedactionPayload>>}
 */
export async function loadRedactionStore(journalPath, options = {}) {
  return await PlanStore.fromJournal(journalPath, {
    ...options,
    journalPath,
    reconcile: async () => "unknown",
  });
}

/**
 * Create the plan for the irreversible apply.
 *
 * `alwaysRequireApproval` is true because applying destroys content, and
 * `dataDigest` carries the staged document's per-operation digest so
 * `beginExecute()` fails closed with DATA_DIGEST_MISMATCH if the document
 * changed after the human looked at it. Approving a redaction of one document
 * must not authorize redacting a different one.
 * @param {PlanStore<RedactionPayload>} store
 * @param {RedactionPayload} payload
 * @param {Partial<import("safe-write-mcp-core").PlanCreateOptions>} [options]
 * @returns {{planToken: string}}
 */
export function createRedactionPlan(store, payload, options = {}) {
  if (!payload?.digest) {
    throw new Error("[redaction-adapter] payload.digest is required — stage the document first");
  }
  const created = store.create(payload, {
    tool: "redaction_apply",
    reason: options.reason ?? "Agent proposed applying staged redactions",
    callerId: options.callerId ?? "agent",
    previewCount: payload.stagedCount ?? payload.targets.length,
    extra: { documentName: payload.documentName, digest: payload.digest },
    // Caller options are spread BEFORE the two security-critical fields, not
    // after. With the spread last, `options.alwaysRequireApproval = false` would
    // silently disable the human gate on an irreversible action, and
    // `options.dataDigest` could replace the binding to the staged document with
    // anything at all. These two are not the caller's to override.
    ...options,
    dataDigest: payload.digest,
    alwaysRequireApproval: true,
  });
  return { planToken: created.planToken };
}

/**
 * Transition an approved plan to `executing`.
 *
 * The payload must be supplied explicitly. After a crash the journal holds the
 * fingerprint but not the payload, so the host has to reconstruct it; the core
 * then rejects a mismatch rather than trusting the caller.
 *
 * The digest is passed as `beginExecute`'s third argument, which is where the
 * core expects the *current* digest of the data — it compares that against the
 * digest the plan was created with and fails closed with DATA_DIGEST_MISMATCH on
 * any difference. Note the core treats a missing third argument as a mismatch
 * whenever the plan carries a digest, so it is not optional here.
 *
 * `currentDigest` defaults to `payload.digest` for the normal path, where the
 * caller re-derives the payload from the document it is about to redact. Pass it
 * explicitly to re-verify against freshly hashed bytes instead of trusting the
 * payload — a caller holding the document should prefer that.
 * @param {PlanStore<RedactionPayload>} store
 * @param {string} planToken
 * @param {RedactionPayload} payload
 * @param {string} [currentDigest]
 * @returns {{ok: true, planToken: string} | {ok: false, error: string, code?: string}}
 */
export function beginRedactionApply(store, planToken, payload, currentDigest) {
  if (!payload) {
    return { ok: false, error: "payload is required for beginRedactionApply" };
  }
  const digest = currentDigest ?? payload.digest;
  if (!digest) {
    return {
      ok: false,
      error: "a current document digest is required — the core fails closed without one",
    };
  }
  const result = store.beginExecute(planToken, payload, digest);
  if (!result.ok) {
    return { ok: false, error: result.error.message, code: result.error.code };
  }
  return { ok: true, planToken };
}

/**
 * Record that the apply succeeded. Only now is "executed" audited.
 * @param {PlanStore<RedactionPayload>} store
 * @param {string} planToken
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function confirmRedactionExecuted(store, planToken) {
  const result = await store.confirmExecuted(planToken);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error?.message ?? "confirmExecuted failed without reporting a reason",
    };
  }
  return { ok: true };
}

/**
 * Release the plan after a failed apply.
 *
 * Only safe when the caller knows the destructive call did not happen — a
 * rejected request or a connection that never opened. On an ambiguous failure
 * such as a timeout mid-request, do NOT call this: leave the plan executing and
 * let a human resolve it, because releasing it invites a second apply on a
 * document that may already have been redacted.
 * @param {PlanStore<RedactionPayload>} store
 * @param {string} planToken
 * @param {string} [reason]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function confirmRedactionFailed(store, planToken, reason) {
  const result = await store.confirmFailed(planToken, reason);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error?.message ?? "confirmFailed failed without reporting a reason",
    };
  }
  return { ok: true };
}

/**
 * Plans stuck mid-apply. Because redaction cannot be reconciled, this list is
 * the only way a stuck plan gets noticed.
 * @param {PlanStore<RedactionPayload>} store
 */
export function listExecutingRedactions(store) {
  return store.listExecuting();
}

// --- Approval UI ------------------------------------------------------------

/**
 * Render a redaction plan for the approval page.
 *
 * Never stringifies the payload. The core's default `renderPlan` dumps the raw
 * payload as JSON, which on this path would print the PII the operation exists
 * to remove onto the review screen — the reviewer would read the secret in order
 * to approve hiding it. Only categories, counts, and the digest appear here.
 * @param {import("safe-write-mcp-core").PendingPlan<RedactionPayload>} plan
 * @returns {{title: string, details: Array<{label: string, value: string}>}}
 */
export function renderRedactionPlan(plan) {
  const payload = plan.payload ?? {};
  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const documentName = payload.documentName || plan.extra?.documentName || "(unnamed document)";
  const digest = payload.digest || plan.extra?.digest || "";

  return {
    title: `Apply redactions: ${documentName}`,
    details: [
      { label: "Document", value: documentName },
      { label: "Staged regions", value: String(payload.stagedCount ?? targets.length) },
      {
        label: "Redaction rules",
        value: targets.length
          ? targets.map((t, i) => `${i + 1}. ${describeTarget(t)}`).join("\n")
          : "(none)",
      },
      { label: "Document digest", value: digest ? `${digest.slice(0, 16)}…` : "(none)" },
      { label: "Agent's reason", value: plan.reason || "(none given)" },
      {
        label: "Irreversible",
        value:
          "Approving permanently destroys the content under every staged mark. " +
          "The redacted text cannot be recovered from the output document, and " +
          "this cannot be undone. Rejecting leaves the staged document intact.",
      },
    ],
  };
}

