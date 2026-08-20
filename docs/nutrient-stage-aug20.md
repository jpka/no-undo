# Nutrient stage — extraction routing and staged redaction (Aug 20, 2026)

Implements the build plan's Aug 26–28 item, six days early, unblocked by the
Data Extraction key landing in `.env`. Everything below was verified against the
live API; the transcripts are committed in `docs/fixtures/`.

## What shipped

| File | Role |
| --- | --- |
| `mcp/nutrient/extraction-adapter.mjs` | Pure routing core: match label first, confidence second, grounding and OCR floors as vetoes |
| `mcp/nutrient/redaction-adapter.mjs` | Stage-then-apply redaction behind the core's approval lifecycle |
| `mcp/nutrient/nutrient-mcp-server.mjs` | Six MCP tools plus the in-process approval UI |
| `mcp/nutrient/extract-probe.mjs` | Schema-extraction probe and per-mode calibration harness |
| `mcp/nutrient/messy-pdf.mjs` | Shared messy-document generator, factored out of the Gate 0 probe |
| `test/extraction-adapter.test.mjs` | 29 tests, fixture replay, no live calls |
| `test/redaction-adapter.test.mjs` | 24 tests, mocked fetch, no live calls |

60/60 tests pass across the repo (`npm test`).

## Correction to the plan: the probe was pointed at the wrong endpoint

The Gate 0 probe calls `/extraction/parse`, which returns layout elements with a
single composite `confidence` per element. The routing design the Aug 20 Nutrient
SE guidance asked for is built on the per-field **match label** and on
`confidenceComponents` — and those only exist on **`/extraction/extract`**, the
schema-based endpoint, under `output.metadata`.

So `/parse` could never have calibrated this gate. `extract-probe.mjs` is the
probe that can; the old one stays as the Gate 0 entitlement record.

## Three findings from the live API

### A. `not_found` fields are invisible to the documented walk

A field the API cannot ground is **omitted from `output.data`** while its
citation, carrying `match: "not_found"`, **remains in `output.metadata`**.

Nutrient's own documented `iter_citations` example walks `data` and reads
`metadata` alongside it. That walk never visits the ungrounded fields — the
single most important routing signal is the one it structurally cannot see. Our
`iterCitations` walks the union of both structures instead and flags
`valuePresent: false`.

Confirmed live: the schema asks for `due_date` and `po_number`, which the test
document does not contain. Both appear in `metadata` only:

```json
"due_date":  {"match":"not_found","source_bboxes":[]}
"po_number": {"match":"not_found","source_bboxes":[]}
```

Note the shape: no `confidence`, no `bbox`. A leaf-citation check that required
either would treat these as nested objects and drop the fields silently.

### B. Every grounding signal cleared two wrong numbers; only `recognitionScore` caught them

In `understand` mode the document reads `Total due $86.86` and `Tax $5.87`. The
API returned:

| Field | Extracted | Document | match | confidence | groundingScore | recognitionScore |
| --- | --- | --- | --- | --- | --- | --- |
| `total_amount` | **26.86** | 86.86 | `id_match` | 0.970 | 0.95 | **0.678** |
| `tax_amount` | **5.27** | 5.87 | `id_match` | 0.970 | 0.95 | **0.569** |

The match label, the composite score, and the grounding score all said
auto-approve, on two wrong numbers. Those two `recognitionScore` values were the
lowest on the page; every other field was ≥ 0.697.

The reason is structural rather than bad luck. The grounding signals answer *is
this value where the model says it is*, which was true — the value was read from
the right box. They cannot answer *were the glyphs read correctly*, which is what
failed. `recognitionScore` is the only signal measuring that, so the router
applies it as a hard veto.

This is the "confidently wrong even in the highest-accuracy mode" case the
Nutrient SE warned about, reproduced on the first live call. For the demo it is
better than the crash: a plausible number, high confidence, silently wrong.

### C. Agentic mode is the most dangerous mode for a gate, not the safest

Running all three modes on the same document:

| mode | fields | wrong values | recognitionScore reported | credits |
| --- | --- | --- | --- | --- |
| `structure` | 7 | 6 | some | 1.5/page |
| `understand` | 16 | 2 (`total_amount`, `tax_amount`) | yes, all fields | 9/page |
| `agentic` | 16 | 2 (`line_items[0..1].quantity`) | **none, any field** | 18/page |

Agentic fixed the totals and broke the line-item table instead: "Parcel 1" and
"Parcel 2" became description `"Parcel"` with quantities 1 and 2 — the row number
shifted into the quantity column. Still two wrong fields, different ones.

And because agentic is VLM-augmented, the API omits `recognitionScore` entirely
(documented: omitted for born-digital text, `not_found`, and VLM-only). So every
signal reads 0.95–0.97, the OCR veto has nothing to bite on, and on the raw
signals 14 of 16 fields would auto-approve including both wrong ones.

**The most accurate mode produced the fewest usable safety signals.** Paying
double bought better answers and less ability to tell whether they were right.

That is why `THRESHOLDS` carries `requireRecognition` per document type. Absence
of an OCR score is not evidence of quality; for `invoice` — the path feeding the
signature gate — an unverifiable read is not an approved read. Born-digital
documents set it false, because with no OCR stage there is nothing to misread.

## The routing rule, in order

1. No match label → human. An ungraded field is not an approved field.
2. `fuzzy_match`, `not_found`, `id_match_partial` → human, unconditionally.
3. Unrecognized label → human, conservatively.
4. Grounded label but no value in `data` → human (contradictory).
5. Grounded but no composite score → human. **Absent is not low**: scoring it 0
   would refer everything, scoring it 1 would approve blindly.
6. `confidence` below the per-type threshold → human.
7. `groundingScore` below the floor → human (value looks inferred, not read).
8. `recognitionScore` present and below the floor → human (OCR may have misread).
9. `recognitionScore` absent and the type requires it → human.

Thresholds are per document type and **all currently marked
`calibrated: false`**. The score is relative and uncalibrated, so a global cutoff
behaves inconsistently across types; `--calibrate` produces the table to set them
from, and a test asserts none of them claims calibration it has not had.

Verified property, asserted per mode against the committed fixtures: **no field
whose value disagrees with the document is ever auto-approved.** In agentic mode
that means zero auto-approvals, which is the correct answer given zero OCR signal.

## Redaction: stage-then-apply on the same gate

`createRedactions` stages (reversible, unattended). `applyRedactions` destroys
content permanently, so it sits behind `alwaysRequireApproval: true` — the same
gate as the eSign send. One approval queue, two irreversible actions.

**Verified live that staging really is reversible and applying really is not.**
Searching the raw bytes is not sufficient — Nutrient re-compresses the content
stream, so the literal string is absent from all three files. Decompressing every
`FlateDecode` stream shows the truth:

| document | size | raw hit | hit after decompression | PII recoverable |
| --- | --- | --- | --- | --- |
| original | 3806 | yes | — | **yes** |
| staged | 3653 | no | **yes** | **yes** |
| applied | 5689 | no | no | **no** |

The staged document looks redacted and is not. That gap is exactly what the
approval gate guards, and the MCP tool description says so explicitly.

### Two deliberate limits, written down rather than papered over

**Redaction cannot be reconciled.** The eSign adapter can ask the gateway whether
a folder is `DRAFT` or `SHARED`. `/build` is one synchronous request returning a
PDF: no job id, no server-side state, nothing to query afterward. So `reconcile`
returns `"unknown"` honestly. A plan interrupted mid-apply stays visibly
`executing` and queryable via `nutrient_list_executing`; a human resolves it.
Guessing `not-done` risks a second destructive apply, guessing `done` puts a
false claim in the audit log — and an audit log that lies is the failure mode this
project exists to prevent.

Consequently, on a **transport error** the apply tool leaves the plan executing
rather than releasing it, because the request may have been processed before the
connection broke. Only a clean rejection, where the call provably did not happen,
releases the plan for retry.

**Dedup is ours alone.** `/build` accepts `Idempotency-Key` only together with
`Prefer: respond-async`; the synchronous path has no server-side dedup. The
per-operation digest — SHA-256 over the staged document bytes plus the canonical
serialized instructions — is both the dedup key and the core's `dataDigest`.
Hashing both halves jointly is what makes an approval specific: the document
alone would let different rules apply under an approved plan, the rules alone
would let a swapped document through.

## Bug found and fixed while testing

`store.beginExecute(planToken, payload)` silently fails the digest check when the
plan carries a `dataDigest`. The core takes the **current** digest as a third
argument and treats a missing one as a mismatch:

```js
store.beginExecute(planToken, payload, currentDigest)
```

The redaction adapter was missing that argument, so every apply failed
`DATA_DIGEST_MISMATCH`. The tests caught it. `beginRedactionApply` now takes an
optional `currentDigest` and the MCP tool re-hashes the bytes on disk rather than
trusting a passed-in value.

Checked the eSign adapter for the same class of bug: it passes `dataDigest: null`,
so its two-argument call is correct. No latent issue there.

## Still open

- Thresholds are uncalibrated. Setting them needs a representative sample per
  document type, not one synthetic invoice. `--calibrate` is the tool for it.
- The MCP `stagedCache` is in-memory and lost on restart, deliberately: after a
  crash a document should be re-staged, not applied from half-known state.
- Redaction presets were exercised with a literal `text` target. The preset names
  for the built-in PII categories are still worth confirming against the live API
  before the demo leans on them.
- Jon Addams offered to review extraction responses where routing felt wrong.
  Finding B is worth sending him: `confidenceComponents` said 0.95 grounding on a
  misread value, and `recognitionScore` was the only dissent.
