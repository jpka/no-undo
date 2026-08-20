## What this is

The build plan's **Aug 26–28 Nutrient stage**, landed six days early — unblocked by the Data Extraction key arriving in `.env`. Extraction routing, staged redaction, a Nutrient MCP server, and 53 new tests. **60/60 pass repo-wide.**

Full write-up: `docs/nutrient-stage-aug20.md`. Live transcripts committed under `docs/fixtures/`.

## Plan correction: the Gate 0 probe was pointed at the wrong endpoint

`/extraction/parse` returns layout elements carrying one composite `confidence` each. The per-field **match labels** and `confidenceComponents` that this entire routing design rests on exist only on **`/extraction/extract`**, the schema-based endpoint, under `output.metadata`.

So `/parse` could never have calibrated this gate. `mcp/nutrient/extract-probe.mjs` is the probe that can; the Gate 0 probe stays as the entitlement record.

## Three findings from the live API

### A. `not_found` fields are invisible to the documented walk

An ungrounded field is **omitted from `output.data`** while its citation, carrying `match: "not_found"`, **remains in `output.metadata`**. Nutrient's own published `iter_citations` example walks `data` and reads `metadata` alongside it — so it structurally cannot see the single most important routing signal.

`iterCitations` walks the union of both structures and flags `valuePresent: false`. Confirmed live — note the shape, since a leaf check requiring `confidence` or `bbox` would treat these as nested objects and drop the fields silently:

```json
"due_date":  {"match":"not_found","source_bboxes":[]}
"po_number": {"match":"not_found","source_bboxes":[]}
```

### B. Every grounding signal cleared two wrong numbers

The document reads `Total due $86.86` and `Tax $5.87`. In `understand` mode:

| Field | Extracted | Document | match | confidence | groundingScore | recognitionScore |
| --- | --- | --- | --- | --- | --- | --- |
| `total_amount` | **26.86** | 86.86 | `id_match` | 0.970 | 0.95 | **0.678** |
| `tax_amount` | **5.27** | 5.87 | `id_match` | 0.970 | 0.95 | **0.569** |

The match label, composite score, and grounding score all said auto-approve, on two wrong numbers. Those two `recognitionScore` values were the lowest on the page; everything else was ≥ 0.697.

This is structural, not luck. The grounding signals answer *is this value where the model says it is* — true, it came from the right box. They cannot answer *were the glyphs read correctly*, which is what failed. `recognitionScore` is the only signal measuring that, so the router applies it as a hard veto.

### C. Agentic mode is the most dangerous mode for a gate, not the safest

| mode | fields | wrong values | `recognitionScore` | credits/page |
| --- | --- | --- | --- | --- |
| `structure` | 7 | 6 | some | 1.5 |
| `understand` | 16 | 2 (`total_amount`, `tax_amount`) | yes, all fields | 9 |
| `agentic` | 16 | 2 (`line_items[0..1].quantity`) | **none, any field** | 18 |

Agentic fixed the totals and broke the line-item table instead — "Parcel 1"/"Parcel 2" became description `"Parcel"` with quantities 1 and 2, the row number shifted into the quantity column. Still two wrong fields, different ones. And being VLM-augmented it omits `recognitionScore` entirely (documented: omitted for born-digital text, `not_found`, and VLM-only), so every signal reads 0.95–0.97 and on the raw signals 14 of 16 fields auto-approve including both wrong ones.

**Double the cost bought better answers and less ability to tell whether they were right.** Hence `requireRecognition` per document type: absence of an OCR score is not evidence of quality. `born_digital` sets it false, since with no OCR stage there is nothing to misread.

## The routing rule, in order

1. No match label → human. An ungraded field is not an approved field.
2. `fuzzy_match` / `not_found` / `id_match_partial` → human, unconditionally.
3. Unrecognized label → human, conservatively.
4. Grounded label but no value in `data` → human (contradictory).
5. Grounded but no composite score → human. **Absent is not low** — scoring it 0 refers everything, scoring it 1 approves blindly.
6. `confidence` below the per-type threshold → human.
7. `groundingScore` below the floor → human (value looks inferred, not read).
8. `recognitionScore` present and below the floor → human (OCR may have misread).
9. `recognitionScore` absent and the type requires it → human.

**Verified property, asserted per mode against the committed fixtures: no field whose value disagrees with the document is ever auto-approved.** In agentic that means zero auto-approvals, which is correct given zero OCR signal.

## Redaction: stage-then-apply on the same gate

`createRedactions` stages (reversible, unattended); `applyRedactions` destroys content permanently and sits behind `alwaysRequireApproval: true` — the same gate as the eSign send. One approval queue, two irreversible actions.

**Verified live that staging really is reversible and applying really is not.** Searching raw bytes is not sufficient, since Nutrient re-compresses the content stream. Decompressing every `FlateDecode` stream:

| document | size | raw hit | hit after decompression | PII recoverable |
| --- | --- | --- | --- | --- |
| original | 3806 | yes | — | **yes** |
| staged | 3653 | no | **yes** | **yes** |
| applied | 5689 | no | no | **no** |

The staged document looks redacted and is not. That gap is what the gate guards, and the MCP tool description says so explicitly.

### Two limits documented rather than papered over

**Redaction cannot be reconciled.** The eSign adapter can ask the gateway whether a folder is `DRAFT` or `SHARED`. `/build` is one synchronous request returning a PDF — no job id, no server-side state, nothing to query afterward. So `reconcile` returns `"unknown"` honestly; a plan interrupted mid-apply stays visibly `executing` and queryable via `nutrient_list_executing`, and a human resolves it. Guessing `not-done` risks a second destructive apply; guessing `done` puts a false claim in the audit log — and an audit log that lies is the failure mode this project exists to prevent.

Consequently a **transport error** leaves the plan executing rather than releasing it, since the request may have been processed before the connection broke. Only a clean rejection releases for retry.

**Dedup is ours alone.** `/build` accepts `Idempotency-Key` only with `Prefer: respond-async`; the synchronous path has none. The per-operation digest — SHA-256 over staged bytes plus canonical serialized instructions — is both the dedup key and the core's `dataDigest`. Both halves are load-bearing: the document alone would let different rules apply under an approved plan, the rules alone would let a swapped document through.

## Bug found and fixed

`store.beginExecute(planToken, payload)` silently fails the digest check when the plan carries a `dataDigest` — the core takes the **current** digest as a third argument and treats a missing one as a mismatch. Every redaction apply failed `DATA_DIGEST_MISMATCH` until the adapter passed it. The tests caught it.

Checked the eSign adapter for the same class of error: it passes `dataDigest: null`, so its two-argument call is correct. No latent issue there.

Also added an `npm test` script — `node --test test/` silently matched nothing useful, which is a trap worth removing.

## Test plan

- [x] `npm test` — 60/60 pass (7 eSign + 29 extraction + 24 redaction)
- [x] Extraction tests replay committed live fixtures; no live API calls
- [x] Redaction tests mock `fetch`; the destructive path is never one misconfiguration from a real document
- [x] MCP server boots, replays its journal, registers all 6 tools, binds the approval UI
- [x] Stage-then-apply verified end to end against the live `/build` endpoint
- [x] Fixtures contain only synthetic data from the generated test document

## Still open

- Thresholds are all marked `calibrated: false`; a test asserts none claims otherwise. Setting them needs a representative sample per document type, not one synthetic invoice. `--calibrate` prints the table.
- Redaction presets were exercised with a literal `text` target; the built-in PII preset names are still assumed and worth confirming before the demo leans on them.
- Finding B is worth sending to Jon Addams, who offered to review responses where routing felt wrong.

Refs the Aug 26–28 item in `build-plan.md` and the SE guidance in `docs/nutrient-support-aug20.md`.
