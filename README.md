# No Undo

> An approval gate for the one step an agent can't take back.
>
> [DevNetwork [API + Cloud + AI] Hackathon 2026](https://api-cloud-ai-hackathon-2026.devpost.com/) — Foxit eSign · Nutrient DWS · Overall

One prompt in, signed document out. A messy invoice is parsed, its fields routed by confidence, its third-party PII redacted and the removal **verified against the document itself**, and only then does a human see it. Every step up to that point is reversible and runs unattended. The one irreversible step — sending for signature — stops at the gate, and survives a process crash without double-sending.

**Where DWS does the heavy lifting:** `/extraction/extract` supplies the per-field confidence signals that decide what a human must look at, `/build` applies the PII redactions, and `/extraction/parse` reads the redacted document back to prove the values are gone — because a redaction call returns HTTP 200 whether or not it removed anything.

**Where Foxit does the heavy lifting:** the PDF Services MCP server assembles the document (`pdf_from_html`) across ~40 reversible tools, and the eSign API — deliberately outside that catalog — performs the one action that cannot be undone.

**[Live showcase](https://jpka.github.io/no-undo/)** (rendered from [`docs/showcase.html`](docs/showcase.html))

---

## The 30 seconds that wins

Nobody else in this hackathon will demo a crash.

Verbatim from the recorded demo — real folder IDs, against the live eSign API:

```
$ NO_UNDO_CRASH_AFTER_FSYNC=1 node agent/esign-agent-loop.mjs --auto-approve --doc messy \
    --prompt "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature."
[agent] Draft: folderId=35704250 planToken=7c61234a… documentSha256=491d5ef8070b98b3…
[esign-audit] executing token=7c61234a... tool=esign_send
[crash-injection] SIGKILL after beginExecute fsync (token=7c61234a...) before the gateway send

# same command, no crash flag
$ node agent/esign-agent-loop.mjs --auto-approve --doc messy --prompt "Take this freight invoice…"
[agent] Recovered 1 stuck-executing plan(s) (reconciled on load):
  - planToken=7c61234a... folderId=35704250 → folderStatus=DRAFT → confirmed not executed → released for retry
[agent] Plan is executing — calling gateway sendDraftFolder…
[agent] Send succeeded — plan executed (verified SHARED)
[agent] Result: { "status": "executed", "verifiedStatus": "SHARED", "folderId": 35704276 }
```

The crash landed on the DRAFT side of the window: the gateway had never been
called, so the plan was released and retried. Had it landed on the other side,
the same query returns SHARED and recovery records the send instead of
repeating it. The branch is chosen by the system of record, not by a guess —
and either way the document goes out exactly once.

---

## What it does

A single natural-language prompt drives the whole pipeline:

```
Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.
```

becomes

1. **Prompt parsed** — `mcp/foxit/prompt-parser.mjs` extracts `{folderName, recipients, docSource, instructions}` into a typed payload. The parsed fields are echoed back in the approval card for human correction before any irreversible step.
2. **Foxit PDF assembly** — `mcp/foxit/pdf-assembly.mjs` renders the invoice data as HTML, then calls `pdf_from_html` → `get_task_result` via the Foxit PDF Services MCP server. Falls back to a deterministic fixture when `NO_FOXIT_MCP=1` or credentials are absent.
3. **Nutrient extraction + confidence routing** — `mcp/nutrient/extraction-adapter.mjs` sends the source document to `/extraction/extract` and routes every field: match label first, confidence second, grounding and OCR-recognition floors as vetoes. The card reports how many fields auto-approved, which ones the recognition floor caught, and which came back ungrounded.
4. **Nutrient redaction, then verification** — `mcp/nutrient/pipeline-redaction.mjs` applies the PII redactions via `/build`, then **reads the redacted document back** through `/extraction/parse` and confirms every target value is gone and every signature field survived. Redaction that cannot be proven fails the run. This is not caution for its own sake — see [the VIN](#what-makes-this-different).
5. **The gate** — `agent/esign-agent-loop.mjs` renders the plan (prompt excerpt, recipients, extraction routing, what was redacted and the confirmation it is gone, document SHA-256, irrevocability warning) and waits for human approval. The approval server binds an ephemeral localhost port.
6. **Irreversible send** — `mcp/foxit/esign-adapter.mjs` calls the Foxit eSign API directly (not via MCP) with client-side dedup: the plan token keys a durable ledger, and `folderStatus` reconciliation (DRAFT vs SHARED) ensures the send happens exactly once.
7. **Signed document out** — after the send, the adapter polls `GET /esign/api/v1/folders/myfolder?folderId=` until `folderStatus == EXECUTED`, then downloads via `GET /esign/api/v1/folders/document/download?folderId=&docNumber=`.

### The document the human reviews

Everything above step 5 is reversible and runs unattended. What reaches the gate is the document that will actually be sent — assembled, redacted, and verified:

```
✍️  Sign: Freight Invoice

  Prompt:              Take this freight invoice, redact the PII, and send it
                       to Alice and Bob for signature.
  Recipients:          1. Alice Smith <alice@example.com>
                       2. Bob Jones <bob@example.com>
  Document SHA-256:    f3589f35e3de7c36… (via enriched-source)

  Nutrient extraction: 0/16 fields auto-approved — 16 need human review —
                       13 caught by OCR recognition floor: vendor_name,
                       payer_name, total_amount, tax_amount, … —
                       2 ungrounded (not_found): due_date, po_number —
                       thresholds calibrated: false

  Nutrient redaction:  3 target set(s) applied (preset: email-address;
                       preset: north-american-phone-number; regex (19 chars,
                       character classes only) — pattern withheld from this
                       view) — 5 value(s) verified absent from the outgoing
                       document, 1 signature field(s) verified intact

  ⚠️ Irreversible:     Approving sends this document to the listed recipients
                       for signature. This action cannot be undone.
```

Two details that are deliberate. The regex target is described by shape and never printed — a redaction pattern embeds the values it hides, so putting it on the review screen would leak them. And `thresholds calibrated: false` is on the card because it is true; a gate that hides its own uncertainty is decoration.

Without Nutrient keys the same pipeline reproduces on a single Foxit credential pair (`NO_NUTRIENT=1`) — the Foxit track's judged path, unchanged.

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

```bash
# 1. Add both credential pairs to .env:
#    FOXIT_CLIENT_ID=...
#    FOXIT_CLIENT_SECRET=...
#    NUTRIENT_API_KEY=...
#    NUTRIENT_DWS_EXTRACTION_API_KEY=...

# 2. Run the full pipeline: assembly → extraction → redaction → verify → gate → send
source .env
node agent/esign-agent-loop.mjs \
  --doc messy \
  --prompt "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature." \
  --recipient "Alice Smith <you@example.com>"
```

`--doc <path>` supplies the document extraction *reads*. `--doc messy` uses the committed generator (skewed text, OCR-hostile glyphs, no PO number) so the run reproduces without shipping a binary. It matters which document extraction sees:

| Extraction reads | Auto-approved | Caught by the OCR recognition floor |
| --- | --- | --- |
| the assembled invoice (clean render) | 0 / 16 | 0 |
| `--doc messy` (a bad scan) | 0 / 16 | 13, named on the card |

The recognition floor only earns its place on a document that was actually scanned badly. The card names which document extraction ran on, because those two rows say very different things about how much judgement was exercised. `--doc messy` currently auto-approves nothing at all — the floor was raised Sep 3 after a live re-run auto-approved two wrong dollar amounts the same floor had caught two weeks earlier (`docs/nutrient-calibration-sep3.md`); a fixed recognition floor on this document has not yet found a value high enough to both catch every wrong read seen so far and still clear any correct one.

The document that gets **signed** is always the assembled, redacted one — `--doc` is an extraction input and is never signed.

Omit `--recipient` and the run refuses to send: the parser's fallback addresses are synthesized, and synthesized addresses are not sent to. Each run costs 3 Nutrient credits (one billed `/build` apply, roughly one credit per redaction action) plus two extraction calls.

### Run the test suite

```bash
npm test
# 255 tests, 45 suites — all green, no live API calls
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
              │                               │
              ▼                               ▼
  ┌───────────────────────┐     ┌───────────────────────────────────┐
  │  mcp/foxit/           │     │  Nutrient DWS (reversible)        │
  │  pdf-assembly.mjs     │────▶│  /extraction/extract → routing    │
  │  HTML → pdf_from_html │     │  /build → applyRedactions         │
  │  (reversible MCP)     │     │  /extraction/parse → VERIFY       │
  └───────────────────────┘     └───────────────────┬───────────────┘
                                                    │
                        ┌───────────────────────────┴──────────────┐
                        │  Verification failed?                    │
                        │  → abort. No draft folder is created.    │
                        │  A redaction that cannot be proven does  │
                        │  not become a send.                      │
                        └───────────────────────────┬──────────────┘
                                                    │ verified
                                                    ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  Approval gate                                                  │
  │  agent/esign-agent-loop.mjs + safe-write-mcp-core               │
  │  Renders: prompt, recipients, extraction routing, what was      │
  │  redacted + proof it is gone, document SHA-256, irrevocability.  │
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
  └─────────────────────────────────────────────────────────────────┘
```

**MCP boundary**: the Foxit PDF Services MCP server handles only reversible work. The irreversible send crosses out of MCP into the eSign API, gated by a human. The approval server shares the PlanStore in-process.

---

## What makes this different

**The gate catches a lie the API tells confidently.** On the first live extraction call, Nutrient's `understand` mode returned `total_amount: 26.86` where the document reads `$86.86` — at `match: id_match`, `confidence: 0.970`, `groundingScore: 0.95`. Every signal a reasonable integrator would threshold on said auto-approve. The number was wrong. Only `recognitionScore` (0.678) dissented, because it is the only signal measuring whether the glyphs were read correctly.

Then `agentic` mode — double the cost, VLM-augmented — got the totals right and silently mangled the line-item table instead, and emits **no `recognitionScore` at all**. Paying more bought better answers and less ability to tell whether they were right.

The signals that tell you an action is safe are not the signals that tell you it is correct. A gate that conflates them is decoration.

**The same API lies twice, in opposite directions.** Extraction reports a wrong number confidently. Redaction reports a successful removal that never happened.

`preset: "vin"` is in `CONFIRMED_PRESETS` because it returned HTTP 200 when probed. It does return 200. It also does not redact. Isolated, one target at a time, against a document containing the well-formed VIN `1FUJGLDR8CLBP8834`:

| Target | HTTP | Output | VIN after apply |
| --- | --- | --- | --- |
| `preset: "vin"` | 200 | valid PDF, 67,142 bytes | **still present** |
| `regex: "[A-HJ-NPR-Z0-9]{17}"` | 200 | valid PDF, 69,467 bytes | removed |

Both calls succeeded. Both returned a document that opens. One did nothing, and the only difference visible to a caller is a byte count — which is not a signal anyone thresholds on. `CONFIRMED_PRESETS` recorded which identifiers the API *accepts*; that is a different question from which ones *match*, and the name had been carrying more weight than the probe behind it.

So the pipeline does not trust the apply call. It re-reads the redacted document and confirms each value is gone before anything reaches the gate.

**The intermediate artifact is a trap.** `stageRedactions` returns a PDF that renders black boxes over the PII. All five planted values are still recoverable from it with one API call:

| Artifact | Bytes | PII surviving | Signature fields |
| --- | --- | --- | --- |
| assembled | 66,463 | 5 / 5 | intact |
| **staged** | 76,684 | **5 / 5** | — |
| applied | 78,461 | **0 / 5** | intact |

An operator who eyeballs the staged PDF, sees the boxes, and forwards it has published everything they believed they had removed. The pipeline discards those bytes and keeps only the inventory. `docs/fixtures/probe-staged.pdf` is committed *because* it is unredacted — it is the evidence, not an accident.

**Redaction boxes destroy signature fields they overlap.** The first version rendered each signer's email next to their Foxit Text Tag; redacting the email destroyed the tag, and the gateway refuses a document with no signature field. Signer addresses no longer appear in the document body — Foxit already carries them in `parties`. The verification step asserts the tags survived, which is the same check that catches this.

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
mcp/nutrient/pipeline-redaction.mjs — stage → apply → verify, fail-closed
mcp/nutrient/                  — extraction routing, staged redaction
mcp/lib/jsonl-audit-sink.mjs   — hash-chained, fsync'd audit trail
test/                          — 255 tests, all green, no live API
docs/showcase.html             — judge-facing walkthrough
docs/demo-video-script.md      — shooting spec for the demo video
docs/nutrient-redaction-sep1.md — six probe findings behind the redaction design
docs/fixtures/                 — committed API responses + redaction artifacts
```

---

## Known gaps

- **Thresholds are uncalibrated.** Every entry in `THRESHOLDS` is marked `calibrated: false`, and a test asserts none of them claims otherwise. Calibrating them needs a representative sample per document type, not one invoice. Until then the defaults are deliberately strict (over-refer rather than under-refer).
- **Approval-server authentication** is upstream in `safe-write-mcp-core` (tracked as [#20](https://github.com/jpka/safe-write-mcp-core/issues/20)): the server binds loopback and checks `Host`/`Origin`/`Sec-Fetch-Site`, but carries no shared secret. The threat model the header checks cover is a malicious browser page, not a hostile local process.
- **Redaction targets are a fixed list, not a detector.** `DEFAULT_TARGETS` covers email, North American phone, and a VIN regex, because those are what this invoice carries and what was probed to actually match. A document with a passport number or an IBAN would pass through untouched, and the verification step would report success — it confirms the values it was *told* to remove are gone, not that the document is free of PII. Deciding what to redact is still a human's job here.
- **The outgoing document carries a trial watermark.** The Nutrient DWS free
  trial stamps *"For Evaluation Purposes Only"* across every document `/build`
  returns, so it is on the redacted PDF that reaches the gate and the recipient.
  It is a licensing artifact, not a pipeline behaviour — the redactions, the
  signature fields and the verification read-back are unaffected — but it is on
  the deliverable, and `docs/fixtures/probe-applied.pdf` shows exactly how.
- **Verification reads the document once.** It confirms the target values are absent from `/extraction/parse` output. A value rendered as an image, or split across text runs in a way the parser rejoins differently, could evade both the redactor and the check.

---

## Tracks

| Track | Entry |
|-------|-------|
| **Foxit** — *Your Agent Shouldn't Sign That* | Plain prompt → Foxit PDF assembly (MCP) → approval gate → eSign (direct API) → signed PDF. Signing outside MCP because the catalog is reversible by design. |
| **Nutrient DWS** — *Turn messy documents into something trustworthy* | Detects and redacts third-party PII, verifies the removal against the document itself, routes the result for human approval, and ends in a signed, tamper-evident PDF with a hash-chained audit trail. DWS does the extraction-with-confidence routing (`/extraction/extract`), the redaction (`/build`), and the verification read-back (`/extraction/parse`). |
| **Overall** | Progress: two shipped servers, a published npm core, 255 tests. Concept: agents are being handed write access to systems where actions cannot be undone, and the industry's answer is "add a confirmation prompt." Feasibility: this is already two shipped servers and a published npm core. |

---

## License

MIT