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
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
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
} from "./redaction-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH =
  process.env.NUTRIENT_JOURNAL_PATH ?? join(__dirname, ".redaction-journal.jsonl");
const EXTRACT_URL = "https://api.nutrient.io/extraction/extract";
const API_VERSION = "2026-05-25";

/** @type {import("safe-write-mcp-core").PlanStore<any>|null} */
let store = null;

function getStore() {
  if (!store) throw new Error("[nutrient-mcp-server] store not initialized");
  return store;
}

/**
 * Staged documents, keyed by plan token, so the apply step can re-read the exact
 * bytes the human approved. Lost on restart by design: after a crash the
 * document must be re-staged rather than applied from a half-known state.
 * @type {Map<string, {bytes: Uint8Array, targets: any[], fileName: string}>}
 */
const stagedCache = new Map();

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
  z.object({ strategy: z.literal("preset"), preset: z.string() }),
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
  async ({ filePath, targets, outputPath }) => {
    const bytes = new Uint8Array(readFileSync(filePath));
    const result = await stageRedactions(bytes, targets, { fileName: basename(filePath) });
    if (!result.ok) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    const staged = outputPath ?? `${filePath}.staged.pdf`;
    writeFileSync(staged, result.bytes);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              stagedPath: staged,
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
  },
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
  async ({ stagedPath, targets, documentName, reason }) => {
    const bytes = new Uint8Array(readFileSync(stagedPath));
    // Digest the bytes on disk right now rather than trusting a value passed in:
    // the plan must be bound to the document that will actually be redacted.
    const digest = operationDigest(bytes, targets);
    const payload = { documentName, digest, targets, stagedCount: targets.length };
    const { planToken } = createRedactionPlan(getStore(), payload, { reason });
    stagedCache.set(planToken, { bytes, targets, fileName: basename(stagedPath) });
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
  },
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
  async ({ planToken, outputPath }) => {
    const cached = stagedCache.get(planToken);
    if (!cached) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              "no staged document for this plan token — re-stage and re-plan " +
              "(this state is deliberately not kept across restarts)",
          },
        ],
      };
    }

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
      await confirmRedactionFailed(getStore(), planToken, applied.error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: applied.error, planToken, status: "retryable" }, null, 2),
          },
        ],
      };
    }

    const out = outputPath ?? `${cached.fileName}.redacted.pdf`;
    writeFileSync(out, applied.bytes);
    await confirmRedactionExecuted(getStore(), planToken);
    stagedCache.delete(planToken);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ planToken, status: "executed", outputPath: out }, null, 2),
        },
      ],
    };
  },
);

// --- Recovery ---------------------------------------------------------------

server.registerTool(
  "nutrient_confirm_failed",
  {
    title: "Release a plan after a known-failed apply",
    description:
      "Release a plan back to retryable. Only correct when you know the apply " +
      "did not happen — releasing after a possible partial apply invites a " +
      "second destructive run.",
    inputSchema: {
      planToken: z.string(),
      reason: z.string().optional(),
    },
  },
  async ({ planToken, reason }) => {
    const r = await confirmRedactionFailed(getStore(), planToken, reason);
    return {
      isError: !r.ok,
      content: [{ type: "text", text: JSON.stringify({ planToken, ...r }, null, 2) }],
    };
  },
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
  async ({ filePath, mode, documentType }) => {
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

    const body = new FormData();
    body.append("file", new Blob([readFileSync(filePath)]), basename(filePath));
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
      return { isError: true, content: [{ type: "text", text: `HTTP ${res.status}: ${raw.slice(0, 400)}` }] };
    }

    const output = JSON.parse(raw).output ?? {};
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
  },
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

main().catch((err) => {
  console.error("[nutrient-mcp-server] fatal:", err);
  process.exit(1);
});
