/**
 * Nutrient DWS MCP server — exposes the extraction routing and the staged
 * redaction lifecycle as tools, and runs the shared approval UI in-process.
 *
 * Tools:
 *   nutrient_extract           — schema extraction with per-field routing
 *   nutrient_stage_redactions  — mark regions (reversible, unattended)
 *   nutrient_plan_redaction    — create the gated plan for the apply
 *   nutrient_apply_redactions  — the irreversible apply, requires approval
 *   nutrient_confirm_failed    — release a plan after a known-failed apply
 *   nutrient_list_executing    — plans stuck mid-apply
 *
 * `nutrient_apply_redactions` is deliberately the only tool that touches the
 * destructive call, and it refuses to run until the core says the plan is
 * approved. There is no unguarded path to applyRedactions from the agent's side.
 *
 * The approval server shares this process's PlanStore, the same arrangement the
 * eSign server uses, so one queue reviews both irreversible actions.
 *
 * Run with: node mcp/nutrient/nutrient-mcp-server.mjs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname, basename, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApprovalServer } from "safe-write-mcp-core";

import { routeFields, summarizeRouting, INVOICE_SCHEMA } from "./extraction-adapter.mjs";
import {
  stageRedactions,
  applyRedactions,
  operationDigest,
  createRedactionPlan,
  beginRedactionApply,
  confirmRedactionExecuted,
  confirmRedactionFailed,
  listExecutingRedactions,
  loadRedactionStore,
  renderRedactionPlan,
  CONFIRMED_PRESETS,
} from "./redaction-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH =
  process.env.NUTRIENT_JOURNAL_PATH ?? join(__dirname, ".redaction-journal.jsonl");
// Every document path the agent supplies is confined under this root. Defaults to
// the process working directory, which keeps the blast radius at the project the
// server was started in rather than the whole filesystem.
const DOCUMENT_ROOT = resolve(process.env.NUTRIENT_DOCUMENT_ROOT ?? process.cwd());
// The root is canonicalized once at startup so every comparison is symlink-aware.
// If the root itself does not exist yet, fall back to the textual form rather
// than crashing — safePath's own check still confines to it.
const CANONICAL_ROOT = (() => {
  try {
    return realpathSync(DOCUMENT_ROOT);
  } catch {
    return DOCUMENT_ROOT;
  }
})();
const EXTRACT_URL = "https://api.nutrient.io/extraction/extract";
const API_VERSION = "2026-05-25";

/** @type {import("safe-write-mcp-core").PlanStore<any>|null} */
let store = null;

function getStore() {
  if (!store) throw new Error("[nutrient-mcp-server] store not initialized");
  return store;
}

/**
 * Confine a document path to the configured document root.
 *
 * Every path in this server arrives from the agent, and two of the tools hand
 * that path straight to `readFileSync` before uploading the bytes to Nutrient. An
 * unconfined path is therefore an exfiltration primitive: ask the server to
 * "redact" `~/.ssh/id_rsa` or `.env` and it uploads the file. The write paths are
 * the mirror image — an arbitrary `outputPath` overwrites whatever it names.
 *
 * `resolve()` alone is not enough. It normalizes text, so `..` segments collapse,
 * but a symlink *inside* the root pointing outside it produces a resolved path
 * that passes the prefix check and still reads or writes the target (CWE-59).
 * Verified: a root-relative `innocent.txt -> /tmp/outside.txt` reads the outside
 * file under a text-only check. So both sides are canonicalized with
 * `realpathSync` before comparison.
 *
 * The candidate may not exist yet — that is normal for an output path — so the
 * walk canonicalizes the deepest ancestor that does exist and re-appends the
 * remaining segments. A non-existent leaf cannot itself be a symlink, but any of
 * its parents can be, which is the case that matters.
 *
 * The prefix check appends the separator so a sibling directory sharing a name
 * prefix (`/docs-evil` next to `/docs`) cannot pass.
 * @param {string} candidate
 * @param {string} label  which parameter this is, for the error message
 * @returns {string} the confined, canonicalized absolute path
 */
function safePath(candidate, label) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`[nutrient-mcp-server] ${label} must be a non-empty path`);
  }
  const resolved = resolve(DOCUMENT_ROOT, candidate);

  // Canonicalize the deepest existing ancestor, keeping the not-yet-created tail.
  let existing = resolved;
  const tail = [];
  for (;;) {
    try {
      existing = realpathSync(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break; // hit the filesystem root
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
  const canonical = tail.length ? join(existing, ...tail) : existing;

  if (canonical !== CANONICAL_ROOT && !canonical.startsWith(CANONICAL_ROOT + sep)) {
    throw new Error(
      `[nutrient-mcp-server] ${label} resolves outside the document root ` +
        `(${CANONICAL_ROOT}). Set NUTRIENT_DOCUMENT_ROOT to widen it deliberately.`,
    );
  }
  return canonical;
}

/**
 * Refuse a write that would clobber its own source.
 *
 * `outputPath` defaulting or being passed equal to the input means the staged or
 * redacted result overwrites the original, and for the apply step the original is
 * the last intact copy of the unredacted document. Fail before the write.
 * @param {string} src
 * @param {string} dest
 */
function assertDistinct(src, dest) {
  if (src === dest) {
    throw new Error(
      "[nutrient-mcp-server] outputPath is the same file as the input " +
        `(${dest}); refusing to overwrite the source document`,
    );
  }
}

/**
 * Run a tool body, turning a thrown error into an MCP error result.
 *
 * Handlers must not throw: a rejected path, an unreadable file, or an unwritable
 * destination should come back as a message the agent can act on rather than a
 * transport-level failure.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T | {isError: true, content: Array<{type: "text", text: string}>}>}
 */
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: String(err?.message ?? err) }],
    };
  }
}

/**
 * Staged documents, keyed by plan token, so the apply step can re-read the exact
 * bytes the human approved. Lost on restart by design: after a crash the
 * document must be re-staged rather than applied from a half-known state.
 *
 * Bounded, because the entries hold whole documents — the very documents that
 * still contain the PII the redaction is meant to remove. A plan the human never
 * approves would otherwise pin that content in memory for the life of the
 * process. Entries are evicted on apply, when the plan's TTL passes, and oldest-
 * first if the cap is reached.
 * @type {Map<string, {bytes: Uint8Array, targets: any[], fileName: string, stagedPath: string, stagedAt: number}>}
 */
const stagedCache = new Map();
const STAGED_CACHE_MAX = 32;
// Matches the store's planTtlMs: once a plan can no longer execute, holding its
// document buys nothing and costs exposure.
const STAGED_CACHE_TTL_MS = 5 * 60 * 1000;

/** Drop expired entries, then oldest-first while over the cap. */
export function pruneStagedCache(now = Date.now()) {
  for (const [token, entry] of stagedCache) {
    if (now - entry.stagedAt > STAGED_CACHE_TTL_MS) stagedCache.delete(token);
  }
  // Map iterates in insertion order, so the first key is the oldest.
  while (stagedCache.size > STAGED_CACHE_MAX) {
    const oldest = stagedCache.keys().next().value;
    stagedCache.delete(oldest);
  }
}

export { safePath, DOCUMENT_ROOT, CANONICAL_ROOT, assertDistinct };

/**
 * Outcomes this process actually observed from `/build`, keyed by plan token.
 *
 * The recovery tool must not take the agent's word for how an apply failed. An
 * agent-supplied "it returned 422" is exactly the claim that would need
 * verifying, and accepting it lets a fabricated status release an approved plan
 * for another irreversible apply with no new human decision. So the status is
 * recorded here by the code that made the call, and recovery is permitted only
 * for tokens whose recorded outcome was a genuine rejection.
 *
 * Deliberately in-memory: a restart forgets the evidence, which fails in the safe
 * direction — the plan stays executing and a human resolves it, rather than the
 * server inventing a provenance it no longer has.
 * @type {Map<string, {rejected: boolean, status: number, transportError: boolean, at: number}>}
 */
const observedFailures = new Map();
const OBSERVED_MAX = 64;
// Evidence expires with the plan it describes. A recorded rejection older than
// the plan TTL cannot authorize anything useful, and keeping it would let a stale
// observation justify a release long after the situation it described.
const OBSERVED_TTL_MS = 5 * 60 * 1000;

/**
 * Record what /build actually returned for a plan's apply attempt.
 * @param {string} planToken
 * @param {{status: number, transportError: boolean}} outcome
 */
function recordApplyFailure(planToken, outcome) {
  observedFailures.set(planToken, {
    // A 4xx/5xx means the request was rejected before the redaction ran, so the
    // document is untouched and a retry is safe. A transport error means the
    // request may have been processed before the connection broke, so it is not.
    rejected: !outcome.transportError && outcome.status >= 400 && outcome.status <= 599,
    status: outcome.status,
    transportError: outcome.transportError,
    at: Date.now(),
  });
  pruneObservedFailures();
}

/**
 * Expire stale evidence and cap the ledger.
 *
 * Entries were previously removed only on a successful release, so a repeatedly
 * failing apply grew the map without bound — the same leak already fixed in the
 * staged-document cache. Expiring on the plan TTL also means recovery cannot rest
 * on an observation older than the plan it belongs to.
 * @param {number} [now]
 */
export function pruneObservedFailures(now = Date.now()) {
  for (const [token, e] of observedFailures) {
    if (now - e.at > OBSERVED_TTL_MS) observedFailures.delete(token);
  }
  while (observedFailures.size > OBSERVED_MAX) {
    observedFailures.delete(observedFailures.keys().next().value);
  }
}

/** Test seam for the recovery-evidence ledger. */
export const __observedFailuresForTest = {
  map: observedFailures,
  record: recordApplyFailure,
  prune: pruneObservedFailures,
  max: OBSERVED_MAX,
  ttlMs: OBSERVED_TTL_MS,
};

/**
 * Test seam for the cache bounds. Not used by the server itself — exported so
 * the eviction policy can be exercised without booting a stdio transport.
 */
export const __stagedCacheForTest = {
  map: stagedCache,
  max: STAGED_CACHE_MAX,
  ttlMs: STAGED_CACHE_TTL_MS,
  prune: pruneStagedCache,
};

const server = new McpServer({
  name: "no-undo-nutrient",
  version: "0.1.0",
  instructions:
    "Nutrient DWS adapter. Extraction routes each field on its match label and " +
    "confidence; fields marked for review must be confirmed by a human before " +
    "downstream use. Redaction is two-step: stage marks regions reversibly, " +
    "apply destroys content permanently and requires approval through the " +
    "localhost approval UI.",
});

// --- Redaction: stage (reversible, unattended) -------------------------------

const targetSchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("text"),
    text: z.string(),
    caseSensitive: z.boolean().optional(),
  }),
  z.object({ strategy: z.literal("regex"), regex: z.string() }),
  z.object({
    strategy: z.literal("preset"),
    preset: z
      .string()
      .describe(
        // Named explicitly because a wrong preset is worse than an error: one that
        // matches nothing stages zero regions and still returns a valid PDF, so the
        // document looks processed and is not redacted at all.
        `Confirmed preset ids (live-verified): ${CONFIRMED_PRESETS.join(", ")}. ` +
          "Short forms such as email, phone, or ssn are rejected with 400.",
      ),
  }),
]);

server.registerTool(
  "nutrient_stage_redactions",
  {
    title: "Stage redactions",
    description:
      "Mark regions for redaction without destroying anything. Reversible, so " +
      "it needs no approval. The output document is NOT safe to share: the " +
      "content under each mark is still present until the apply step runs.",
    inputSchema: {
      filePath: z.string().describe("Document to stage redactions on"),
      targets: z.array(targetSchema).min(1).describe("What to redact"),
      outputPath: z.string().optional().describe("Where to write the staged document"),
    },
  },
  async ({ filePath, targets, outputPath }) =>
    guarded(async () => {
      const src = safePath(filePath, "filePath");
      const dest = safePath(outputPath ?? `${filePath}.staged.pdf`, "outputPath");
      assertDistinct(src, dest);
      const bytes = new Uint8Array(readFileSync(src));
      const result = await stageRedactions(bytes, targets, { fileName: basename(src) });
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      writeFileSync(dest, result.bytes);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                stagedPath: dest,
                digest: result.digest,
                staged: result.staged,
                warning:
                  "Content under each mark is still recoverable from this file. " +
                  "Call nutrient_plan_redaction, get human approval, then apply.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
);

// --- Redaction: plan the apply ----------------------------------------------

server.registerTool(
  "nutrient_plan_redaction",
  {
    title: "Plan a redaction apply",
    description:
      "Create the approval-gated plan for applying staged redactions. Returns a " +
      "plan token that cannot be executed until a human approves it in the " +
      "localhost approval UI.",
    inputSchema: {
      stagedPath: z.string().describe("The staged document from nutrient_stage_redactions"),
      targets: z.array(targetSchema).min(1).describe("The same targets used to stage"),
      documentName: z.string().describe("Human-readable name for the approval page"),
      reason: z.string().optional().describe("Why the agent wants this applied"),
    },
  },
  async ({ stagedPath, targets, documentName, reason }) =>
    guarded(async () => {
      const src = safePath(stagedPath, "stagedPath");
      const bytes = new Uint8Array(readFileSync(src));
      // Digest the bytes on disk right now rather than trusting a value passed in:
      // the plan must be bound to the document that will actually be redacted.
      const digest = operationDigest(bytes, targets);
      const payload = { documentName, digest, targets, stagedCount: targets.length };
      const { planToken } = createRedactionPlan(getStore(), payload, { reason });
      // Store the confined path so the apply step derives its output from a path
      // that has already been validated, never from raw agent input.
      stagedCache.set(planToken, {
        bytes,
        targets,
        fileName: basename(src),
        stagedPath: src,
        stagedAt: Date.now(),
      });
      pruneStagedCache();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                planToken,
                status: "awaiting_approval",
                digest,
                message:
                  "Open the approval UI to approve or reject. Applying destroys content permanently.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
);

// --- Redaction: apply (irreversible, gated) ---------------------------------

server.registerTool(
  "nutrient_apply_redactions",
  {
    title: "Apply staged redactions (irreversible)",
    description:
      "Permanently destroy the content under every staged mark. Requires an " +
      "approved plan token; the core refuses otherwise. On an ambiguous failure " +
      "the plan is left executing for a human rather than auto-released.",
    inputSchema: {
      planToken: z.string().describe("Approved plan token from nutrient_plan_redaction"),
      outputPath: z.string().optional().describe("Where to write the redacted document"),
    },
  },
  async ({ planToken, outputPath }) =>
    guarded(async () => {
      pruneStagedCache();
      const cached = stagedCache.get(planToken);
      if (!cached) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "no staged document for this plan token. Either it was never staged, or the " +
                "entry aged out — staged documents still contain the unredacted content, so " +
                "they are held only as long as the plan can execute. Re-stage and re-plan. " +
                "(This state is deliberately not persisted across restarts either.)",
            },
          ],
        };
      }

      // Resolve the destination before doing anything irreversible: an unwritable
      // or out-of-root path should fail while the document is still intact, not
      // after the content has been destroyed.
      const dest = safePath(outputPath ?? `${cached.stagedPath}.redacted.pdf`, "outputPath");
      assertDistinct(cached.stagedPath, dest);

      const digest = operationDigest(cached.bytes, cached.targets);
      const payload = {
        documentName: cached.fileName,
        digest,
        targets: cached.targets,
        stagedCount: cached.targets.length,
      };

      const begun = beginRedactionApply(getStore(), planToken, payload, digest);
      if (!begun.ok) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify(begun, null, 2) }] };
      }

      const applied = await applyRedactions(cached.bytes, cached.targets, {
        fileName: cached.fileName,
      });

      if (!applied.ok) {
        // Record what /build actually returned, so the recovery tool can check
        // observed evidence instead of trusting the agent's account of it.
        recordApplyFailure(planToken, {
          status: applied.status,
          transportError: applied.transportError,
        });
        // A rejection means the destructive call did not happen, so releasing the
        // plan is safe. A transport error is ambiguous — the request may have been
        // processed before the connection broke — so the plan stays executing and
        // a human decides. Guessing here is how a double apply happens.
        if (applied.transportError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: applied.error,
                    planToken,
                    status: "executing",
                    note:
                      "Transport failed mid-request, so whether the apply landed is unknown. " +
                      "The plan is left executing; /build cannot be reconciled, so inspect the " +
                      "document and call nutrient_confirm_failed only if certain nothing applied.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        // Report the state the plan is actually in. If the release itself failed
        // the plan is still executing, and telling the agent "retryable" would
        // send it into a retry that beginRedactionApply then refuses.
        const released = await confirmRedactionFailed(getStore(), planToken, applied.error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: applied.error,
                  planToken,
                  status: released.ok ? "retryable" : "executing",
                  releaseError: released.ok ? undefined : released.error,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // The remote destructive call has already landed. The redacted bytes exist
      // only in memory, so a throw here would discard the sole copy of the result
      // of an irreversible operation and leave the plan stuck with no explanation.
      // Catch it and report precisely what is true: the content was destroyed
      // upstream, and the output was not persisted.
      try {
        writeFileSync(dest, applied.bytes);
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  planToken,
                  status: "executing",
                  applied: true,
                  outputPersisted: false,
                  error: `redactions were applied upstream but writing ${dest} failed: ${String(err?.message ?? err)}`,
                  note:
                    "The destructive call already happened, so this is NOT retryable — " +
                    "re-running would redact an already-redacted document under a new plan. " +
                    "The redacted output is lost and must be regenerated from the source. " +
                    "The plan is left executing; resolve it by hand.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // The content is gone at this point, so a failed confirmation is a
      // bookkeeping problem, not a reason to claim the apply did not happen. Say
      // both things: the document was redacted, and the audit record is incomplete.
      const confirmed = await confirmRedactionExecuted(getStore(), planToken);
      stagedCache.delete(planToken);

      return {
        isError: !confirmed.ok,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                planToken,
                status: "executed",
                outputPath: dest,
                auditWarning: confirmed.ok
                  ? undefined
                  : `redactions were applied but the plan could not be confirmed: ${confirmed.error}. ` +
                    "The plan may still show as executing; resolve it before trusting the audit log.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
);

// --- Recovery ---------------------------------------------------------------

server.registerTool(
  "nutrient_confirm_failed",
  {
    title: "Release a plan whose apply this server saw rejected",
    description:
      "Release a plan back to retryable. Takes no evidence from the caller: the " +
      "server checks the /build outcome it recorded itself when the apply ran. " +
      "Only a genuine 4xx/5xx rejection, where the document was provably not " +
      "touched, permits a release. Transport failures, timeouts, and anything " +
      "this process did not observe are refused, and those plans stay executing " +
      "for a human. Note that a released plan remains approved, so the retry " +
      "does not require fresh approval.",
    inputSchema: {
      planToken: z.string(),
      reason: z.string().optional().describe("Operator note, recorded in the audit trail"),
    },
  },
  async ({ planToken, reason }) =>
    guarded(async () => {
      // An earlier version took a `rejectedWithStatus` argument from the agent.
      // That was not a gate: it asked the caller to self-certify the very fact
      // that needed verifying, so a fabricated 422 released an approved plan for
      // another irreversible apply. The server made the call and already knows
      // the answer, so it consults its own record and ignores the caller's view.
      //
      // Pruned first so evidence older than the plan TTL cannot authorize a
      // release: an expired observation describes a situation that no longer holds.
      pruneObservedFailures();
      const observed = observedFailures.get(planToken);

      if (!observed) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  planToken,
                  status: "executing",
                  error:
                    "this process has no recorded /build failure for that plan, so there " +
                    "is no evidence the apply was rejected",
                  note:
                    "Recovery is refused rather than guessed. If the apply genuinely never " +
                    "ran, re-plan from the staged document; if its outcome is unknown, a " +
                    "human must inspect the document — see nutrient_list_executing.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (!observed.rejected) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  planToken,
                  status: "executing",
                  observedStatus: observed.status,
                  observedTransportError: observed.transportError,
                  error:
                    "the recorded outcome does not prove the apply was rejected, so " +
                    "releasing the plan could permit a second destructive run",
                  note:
                    "/build has no server-side state to reconcile against, so an ambiguous " +
                    "failure is a human decision. The plan stays executing.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const r = await confirmRedactionFailed(
        getStore(),
        planToken,
        reason
          ? `observed HTTP ${observed.status}: ${reason}`
          : `observed HTTP ${observed.status}`,
      );
      if (r.ok) observedFailures.delete(planToken);
      return {
        isError: !r.ok,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                planToken,
                ...r,
                status: r.ok ? "retryable" : "executing",
                observedStatus: observed.status,
                note: r.ok
                  ? "Released on the server's own record of a rejected apply. The plan is " +
                    "still approved, so a retry needs no new approval — only retry the " +
                    "operation the human already reviewed."
                  : undefined,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
);

server.registerTool(
  "nutrient_list_executing",
  {
    title: "List plans stuck mid-apply",
    description:
      "Plans that began an apply and never confirmed. Because /build has no " +
      "server-side state to reconcile against, this list is the only way a " +
      "stuck redaction becomes visible.",
    inputSchema: {},
  },
  async () => {
    const plans = listExecutingRedactions(getStore());
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              executing: plans,
              count: plans.length,
              note:
                "Redaction cannot be reconciled server-side. Resolution is a human " +
                "decision; the audit log will not claim an outcome it cannot verify.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// --- Extraction -------------------------------------------------------------

server.registerTool(
  "nutrient_extract",
  {
    title: "Extract fields with routing",
    description:
      "Run schema-based extraction and route every field: auto-approve or send " +
      "to human review. Routing uses the match label first, then confidence, " +
      "then grounding and OCR recognition floors.",
    inputSchema: {
      filePath: z.string().describe("Path to the document to extract"),
      mode: z
        .enum(["structure", "understand", "agentic"])
        .default("understand")
        .describe("Parse mode. agentic reports no OCR score, so more fields need review."),
      documentType: z
        .string()
        .default("invoice")
        .describe("Threshold set to apply (invoice, born_digital, or DEFAULT)"),
    },
  },
  async ({ filePath, mode, documentType }) =>
    guarded(async () => {
      const key = process.env.NUTRIENT_DWS_EXTRACTION_API_KEY;
      if (!key) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "missing NUTRIENT_DWS_EXTRACTION_API_KEY (Data Extraction is a separate product from the Processor key)",
            },
          ],
        };
      }

      // Confined before the read: this path's bytes get uploaded to a third party,
      // so an unrestricted path here would be an exfiltration primitive.
      const src = safePath(filePath, "filePath");

      const body = new FormData();
      body.append("file", new Blob([readFileSync(src)]), basename(src));
      body.append(
        "instructions",
        JSON.stringify({
          schema: INVOICE_SCHEMA,
          parseConfig: { mode },
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
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `network: ${String(err)}` }] };
      }
      const raw = await res.text();
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `HTTP ${res.status}: ${raw.slice(0, 400)}` }],
        };
      }

      // A 200 with a body that is not JSON, or is JSON without an `output`, must
      // not reach the router: routeFields on {} reports zero fields, which reads
      // as "nothing needed review" — the most dangerous possible way to fail.
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `extraction returned HTTP 200 with a non-JSON body: ${raw.slice(0, 200)}`,
            },
          ],
        };
      }
      if (!parsed?.output || typeof parsed.output !== "object") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "extraction response has no `output` object; refusing to report an empty routing result as success",
            },
          ],
        };
      }

      const output = parsed.output;
      const routed = routeFields(output.data ?? {}, output.metadata ?? {}, { documentType });
      const summary = summarizeRouting(routed);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                mode,
                thresholds: routed.limits,
                summary: {
                  total: summary.total,
                  auto: summary.auto,
                  needsReview: summary.human,
                  byMatch: summary.byMatch,
                  vetoedByOcrFloor: summary.savedByRecognition,
                },
                fields: routed.fields.map((f) => ({
                  field: f.field,
                  value: f.valuePresent ? f.value : null,
                  valuePresent: f.valuePresent,
                  match: f.match,
                  confidence: f.confidence,
                  recognitionScore: f.recognitionScore,
                  route: f.route,
                  reason: f.reason,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
);

// --- Main -------------------------------------------------------------------

async function main() {
  store = await loadRedactionStore(JOURNAL_PATH);
  console.error("[nutrient-mcp-server] store initialized, journal replayed");

  const stuck = listExecutingRedactions(store);
  if (stuck.length) {
    console.error(
      `[nutrient-mcp-server] WARNING: ${stuck.length} plan(s) stuck mid-apply and cannot be ` +
        "reconciled automatically — inspect them via nutrient_list_executing",
    );
  }

  const approval = await startApprovalServer(store, {
    renderPlan: renderRedactionPlan,
    title: "Redaction Approval Queue",
  });
  console.error(
    `[nutrient-mcp-server] approval server listening on http://${approval.host}:${approval.port}`,
  );

  await server.connect(new StdioServerTransport());
  console.error("[nutrient-mcp-server] connected over stdio");

  const shutdown = async () => {
    await approval.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run when executed directly. Importing this module (the cache tests do)
// must not open a stdio transport or bind the approval port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[nutrient-mcp-server] fatal:", err);
    process.exit(1);
  });
}
