# No Undo

> An approval gate for the one step an agent can't take back.
>
> [DevNetwork [API + Cloud + AI] Hackathon 2026](https://api-cloud-ai-hackathon-2026.devpost.com/) — Foxit eSign · Nutrient DWS · Overall

One prompt in, signed document out. Every reversible step runs unattended. The one irreversible step — sending for signature — stops at a human approval gate that survives a process crash without double-sending.

**[Live showcase](https://jpka.github.io/no-undo/)** (rendered from [`docs/showcase.html`](docs/showcase.html))

---

## The 30 seconds that wins

Nobody else in this hackathon will demo a crash.

```
$ node agent/esign-agent-loop.mjs --auto-approve --prompt "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature."
[agent] Creating draft folder…
[agent] Draft: folderId=fld_abc123 planToken=pln_…
[agent] Auto-approved (no human interaction)
[agent] beginExecute…
# ← process dies here (NO_UNDO_CRASH_AFTER_FSYNC=1)
# restart
$ node agent/esign-agent-loop.mjs --auto-approve --prompt "Take this freight invoice…"
[agent] Recovered 1 stuck-executing plan(s) (outcome unknown, reconciled on load):
  - planToken=pln_… folderId=fld_abc123 → folderStatus=SHARED → confirmed executed
[agent] Result: { "status": "executed" }
```

The send happened exactly once. The audit log is honest about what happened. That is the demo.

---

## What it does

A single natural-language prompt drives the whole pipeline:

```
Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.
```

becomes

1. **Prompt parsed** — `mcp/foxit/prompt-parser.mjs` extracts `{folderName, recipients, docSource, instructions}` into a typed payload. The parsed fields are echoed back in the approval card for human correction before any irreversible step.
2. **Foxit PDF assembly** — `mcp/foxit/pdf-assembly.mjs` renders the invoice data as HTML, then calls `pdf_from_html` → `get_task_result` via the Foxit PDF Services MCP server. The assembled bytes become the document; their SHA-256 becomes the digest line in the approval card. Falls back to a deterministic fixture when `NO_FOXIT_MCP=1` or credentials are absent.
3. **The gate** — `agent/esign-agent-loop.mjs` renders the plan (prompt excerpt, recipients, document digest, irrevocability warning) and waits for human approval. The approval server binds an ephemeral localhost port.
4. **Irreversible send** — `mcp/foxit/esign-adapter.mjs` calls the Foxit eSign API directly (not via MCP) with client-side dedup: the plan token keys a durable ledger, and `folderStatus` reconciliation (DRAFT vs SHARED) ensures the send happens exactly once.
5. **Signed document out** — after the send, the adapter polls `GET /esign/api/v1/folders/myfolder?folderId=` until `folderStatus == EXECUTED`, then downloads via `GET /esign/api/v1/folders/document/download?folderId=&docNumber=`.

### Optional: Nutrient DWS enrichment

When `NUTRIENT_API_KEY` + `NUTRIENT_DWS_EXTRACTION_API_KEY` are present, the pipeline enriches before the gate: extraction-with-confidence routing and staged PII redaction. Without them, the pipeline reproduces with a single Foxit credential pair — the Foxit track's judged path.

---

## Why signing stays outside the MCP catalog

The Foxit PDF Services MCP server exposes ~40 tools for *reversible* document work. Signing is deliberately excluded. To send anything for signature, the agent must cross a boundary into the eSign API and a human must be involved.

That handoff is the graded artifact. Our defense: **signing does not belong in the MCP catalog because it is the only irreversible step.** The 40-tool catalog is intentionally reversible; moving signing into it would collapse the safety boundary the challenge grades. The gate is the boundary.

This pattern was validated in writing by Jason Welch, Senior Strategic Alliance Manager at Foxit: *"Based on the current Foxit tool surface, I would keep signing outside the MCP catalog for this submission… Your explicit approval gate before the irreversible send is therefore a sensible pattern to defend."* (Technical opinion from a Foxit contact, given in a trial-support context — not an official sponsor-program endorsement.)

---

## Reproduce it

### Prerequisites

- Node.js 18+
- A Foxit developer account ([self-serve, instant](https://developer-api.foxit.com))
- (Optional) A Nutrient DWS account ([free tier, no credit card](https://dashboard.nutrient.io))

### Install

```bash
git clone https://github.com/jpka/no-undo.git
cd no-undo
npm install
```

### Path A — Foxit only (one credential pair, the judged Foxit track)

```bash
# 1. Add credentials to .env (see .env.example)
#    FOXIT_CLIENT_ID=...
#    FOXIT_CLIENT_SECRET=...

# 2. Run the full pipeline against the live Foxit APIs (prompt parsing + Nutrient enrichment)
source .env
node agent/esign-agent-loop.mjs --auto-approve --prompt "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature."

# 3. Or use fixture mode for PDF assembly (Foxit eSign credentials still required for the gateway)
set -a; source .env; set +a
NO_FOXIT_MCP=1 node agent/esign-agent-loop.mjs --auto-approve --prompt "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature."
```

### Path B — Full pipeline (Foxit + Nutrient)

> **Note:** Nutrient enrichment is currently a stub — it proves the single-pipeline wiring (prompt → enrichment → assembly → gate) but does not make live extraction calls. The Foxit path is fully functional. See [Known gaps](#known-gaps).

```bash
# 1. Add both credential pairs to .env:
#    FOXIT_CLIENT_ID=...
#    FOXIT_CLIENT_SECRET=...
#    NUTRIENT_API_KEY=...
#    NUTRIENT_DWS_EXTRACTION_API_KEY=...

# 2. Run with Nutrient enrichment
source .env
node agent/esign-agent-loop.mjs --auto-approve --prompt "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature."
```

### Run the test suite

```bash
npm test
# 191 tests, 33 suites — all green, no live API calls
```

Every extraction claim in this repo is backed by a committed API response. The fixtures and the test suite need no credentials; the probes make live billed calls and do.

---

## Architecture

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  Prompt                                                         │
  │  "Take this freight invoice, redact the PII, send to Alice…"    │
  └───────────────────────────┬─────────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  mcp/foxit/prompt-parser.mjs                                    │
  │  Regex + zod → {folderName, recipients, docSource, instructions}│
  └───────────────────────────┬─────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │ (optional, when keys present)  │
              ▼                               ▼
  ┌───────────────────────┐     ┌───────────────────────────────────┐
  │  Nutrient DWS         │     │  mcp/foxit/pdf-assembly.mjs       │
  │  Extraction routing   │     │  HTML → pdf_from_html → bytes     │
  │  Staged redaction     │     │  (reversible MCP calls)           │
  └───────────┬───────────┘     └───────────────────┬───────────────┘
              │                                     │
              └──────────────┬──────────────────────┘
                             │
                             ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  Approval gate                                                  │
  │  agent/esign-agent-loop.mjs + safe-write-mcp-core               │
  │  Renders: prompt excerpt, recipients, document SHA-256,         │
  │  irrevocability warning. Human approves or rejects.             │
  │  Crash-safe: beginExecute fsyncs BEFORE the gateway call.       │
  └───────────────────────────┬─────────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  Foxit eSign (direct API, not MCP)                              │
  │  mcp/foxit/esign-adapter.mjs                                    │
  │  createfolder → sendDraftFolder → confirmExecuted               │
  │  folderStatus reconciliation: DRAFT/SHARED → exactly-once       │
  └───────────────────────────┬─────────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  Signed document                                                │
  │  pollUntilSigned → downloadSignedDocument                       │
  │  Polls EXECUTED, then GET /document/download                    │
  └─────────────────────────────────────────────────────────────────┘
```

**MCP boundary**: the Foxit PDF Services MCP server handles only reversible work. The irreversible send crosses out of MCP into the eSign API, gated by a human. The approval server shares the PlanStore in-process.

---

## What makes this different

**The gate catches a lie the API tells confidently.** On the first live extraction call, Nutrient's `understand` mode returned `total_amount: 26.86` where the document reads `$86.86` — at `match: id_match`, `confidence: 0.970`, `groundingScore: 0.95`. Every signal a reasonable integrator would threshold on said auto-approve. The number was wrong. Only `recognitionScore` (0.678) dissented, because it is the only signal measuring whether the glyphs were read correctly.

Then `agentic` mode — double the cost, VLM-augmented — got the totals right and silently mangled the line-item table instead, and emits **no `recognitionScore` at all**. Paying more bought better answers and less ability to tell whether they were right.

The signals that tell you an action is safe are not the signals that tell you it is correct. A gate that conflates them is decoration.

**Crash-safety is a property, not a promise.** `beginExecute()` journals `executing` and fsyncs *before* the gateway call. A process that dies mid-send leaves a plan visibly stuck in `executing` — a queryable state, not a forgotten one. On restart the journal replays and the core asks the gateway the only question that matters: `folderStatus` DRAFT (didn't send) vs SHARED (did send). The dangerous window straddles the call, and most designs don't model it.

---

## Project layout

```
agent/esign-agent-loop.mjs     — prompt → draft → gate → send → signed doc
mcp/foxit/prompt-parser.mjs    — natural-language → typed EsignPayload
mcp/foxit/pdf-assembly.mjs     — HTML → pdf_from_html → bytes (real Foxit MCP)
mcp/foxit/esign-adapter.mjs    — crash-safe eSign lifecycle + dedup ledger
mcp/foxit/esign-probe.mjs      — live API probe (committed fixtures)
mcp/foxit/call-tool.mjs        — MCP stdio transport
mcp/nutrient/                  — extraction routing, staged redaction
mcp/lib/jsonl-audit-sink.mjs   — hash-chained, fsync'd audit trail
test/                          — 191 tests, all green, no live API
docs/showcase.html             — judge-facing walkthrough
docs/demo-video-script.md      — shooting spec for the demo video
docs/fixtures/                 — committed API responses (Gate 0, Nutrient)
```

---

## Known gaps

- **Thresholds are uncalibrated.** Every entry in `THRESHOLDS` is marked `calibrated: false`, and a test asserts none of them claims otherwise. Calibrating them needs a representative sample per document type, not one invoice. Until then the defaults are deliberately strict (over-refer rather than under-refer).
- **Approval-server authentication** is upstream in `safe-write-mcp-core` (tracked as [#20](https://github.com/jpka/safe-write-mcp-core/issues/20)): the server binds loopback and checks `Host`/`Origin`/`Sec-Fetch-Site`, but carries no shared secret. The threat model the header checks cover is a malicious browser page, not a hostile local process.
- **Signed-document retrieval** is cut-list #1 until the live probe confirms the download route. The send is idempotent and audit-logged; polling never re-sends, only waits for signers to finish.

---

## Tracks

| Track | Entry |
|-------|-------|
| **Foxit** — *Your Agent Shouldn't Sign That* | Plain prompt → Foxit PDF assembly (MCP) → approval gate → eSign (direct API) → signed PDF. Signing outside MCP because the catalog is reversible by design. |
| **Nutrient DWS** — *Turn Documents Into Something People Actually Trust* | Extraction-with-confidence routing + staged redaction, both behind the same gate. |
| **Overall** | Progress: two shipped servers, a published npm core, 191 tests. Concept: agents are being handed write access to systems where actions cannot be undone, and the industry's answer is "add a confirmation prompt." Feasibility: this is already two shipped servers and a published npm core. |

---

## License

MIT