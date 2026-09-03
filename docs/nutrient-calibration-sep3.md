# Nutrient extraction threshold calibration — a live re-run finds a live gap (Sep 3, 2026)

Runs `node mcp/nutrient/extract-probe.mjs --calibrate --fixture`, the tool the
build plan names for the remaining "calibrate the thresholds" item, against
the same generated messy invoice used Aug 20. Also re-ran `understand` mode
twice more, same day, to check whether the result was request-to-request
noise or a stable snapshot.

**What was live-verified:** all three modes reproduce the Aug 20 findings —
`structure` and `agentic` are unchanged in shape. `understand` reproduces the
same two wrong dollar amounts, but with a materially different
`recognitionScore`, high enough to clear the threshold this file itself had
set from the Aug 20 sample. Two immediate re-runs of `understand` returned
byte-for-byte identical scores, so this is not per-request noise — it is a
new, stable engine snapshot that differs from the one three weeks earlier.

## The finding: the same wrong values, a different recognitionScore

Both `understand` runs read the invoice's `$86.86` total and `$5.87` tax as
something else, at `match: id_match`, `confidence: 0.970`,
`groundingScore: 0.95` in both cases — every grounding signal cleared both
values in both snapshots. `recognitionScore` is what should catch this:

| Snapshot | `total_amount` (doc: 86.86) | recog | `tax_amount` (doc: 5.87) | recog |
| --- | --- | --- | --- | --- |
| Aug 20 | 26.86 | 0.678 | 5.27 | 0.569 |
| Aug 29 | 26.86 | 0.678 | 5.27 | 0.569 |
| Sep 3 (×3, identical) | 86.26 | 0.834 | 5.27 | 0.842 |

At the threshold this repo shipped from the Aug 20 sample —
`invoice.recognition: 0.8` — the Aug 20/29 snapshot is caught (0.678, 0.569 <
0.8) and the Sep 3 snapshot is not (0.834, 0.842 > 0.8). Run against
`extraction-adapter.mjs` as committed before this change, the Sep 3 fixture
auto-approved both wrong values:

```
auto  total_amount   match=id_match  conf=0.970  ground=0.950  recog=0.834
      id_match with confidence 0.970 at or above 0.85
      value: 86.26
auto  tax_amount     match=id_match  conf=0.970  ground=0.950  recog=0.842
      id_match with confidence 0.970 at or above 0.85
      value: 5.27
```

`test/extraction-adapter.test.mjs` picked the newest committed fixture by
filename, so this was silent until the property test was pointed at the new
fixture — at which point it failed, live, against the repo's own claim that
"no field whose value disagrees with the document is ever auto-approved."

The wrong-value `recognitionScore` moved +0.164 (on `total_amount`) to
+0.273 (on `tax_amount`) between the Aug 20/29 snapshot and Sep 3, with match
label, confidence, and groundingScore all unchanged. Nothing else on the
response signaled that anything had shifted.

One more data point worth naming: the highest `recognitionScore` observed on
a *correct* field across every committed sample is 0.859 (the Aug 20/29
`line_items[2]` row — "Handling", correct on all three of description,
quantity, unit price). That sits only 0.017 above the worst wrong score seen
so far (0.842). `recognitionScore` on this document does not cleanly separate
right from wrong; it separates them by a margin currently smaller than the
drift already observed between two live snapshots.

## What changed

`mcp/nutrient/extraction-adapter.mjs`:

- `THRESHOLDS.invoice.recognition`: `0.8` → `0.9`. Clears the worst wrong
  score seen (0.842) by 0.058 — a real margin, chosen knowing it is smaller
  than the +0.164 drift already observed once, and stated as such in the code
  comment rather than presented as a solved problem.
- `THRESHOLDS.DEFAULT.recognition`: `0.8` → `0.92`. No live data backs
  `DEFAULT` at all, so it stays stricter than the one type that now has some.
- `confidence` and `grounding` were left alone. Every `id_match` field in
  every committed sample scores confidence 0.95–0.97 and groundingScore 0.95;
  every `not_found` field scores 0.4. That gap has held across all three
  snapshots — nothing in this run argues for moving either floor.

Consequence, checked against all seven currently committed extraction
fixtures (2 structure, 3 understand, 2 agentic): **auto-approval on this
document is now 0 fields, in every mode, on every snapshot.** Before this
change it was 3 (a correct line-item row, Aug 20/29 only) or 2 (both wrong,
Sep 3 only). Going to zero is the correct answer given the evidence, not a
regression — the code's own stated policy is that an uncalibrated threshold
should over-refer, not under-refer, and this document has not yet produced a
single field this repo can show is both correct and reliably scored above the
noise floor.

`test/extraction-adapter.test.mjs`:

- The safety-property tests (`no wrong value is ever auto-approved`, the OCR
  veto regression, the not_found and structure-mode checks) now run against
  **every** committed fixture per mode, not just the newest. That is what
  would have caught this the moment the Sep 3 fixture was committed, instead
  of requiring a human to notice. `fixturesForMode()` replaces the old
  newest-only `fixture()` helper.
- The OCR-veto regression test no longer hardcodes which recognitionScore
  value catches the two wrong fields (Aug 20/29's 0.678/0.569 vs Sep 3's
  0.834/0.842) — it asserts the outcome (route stays `human`, reason names
  `recognitionScore`) holds on every snapshot, since the exact score is now
  known to drift.

`README.md`: the sample approval card and the `--doc messy` demo table
updated from `2/16 auto-approved` to `0/16`, matching the new, real behavior.

## What this is not

**Not calibration.** `THRESHOLDS.invoice.calibrated` stays `false`. Three
live samples of one synthetic, deliberately OCR-hostile document is not the
"representative sample per document type" the code's own `CALIBRATION
STATUS` comment requires before making that claim — if anything, this run
argues the bar is right: the first attempt to actually rely on a
single-sample-derived number broke live, within three weeks, with no warning
signal on the response.

**Not a proof the new floor is safe.** The chosen margin (0.058) is smaller
than the drift already measured once (0.164). A repeat of that drift clears
0.90 too, and there is no headroom left below 1.0 to out-run a third repeat.
Recalibrate — rerun `--calibrate --fixture` and re-check the resulting
scores against the thresholds — before any live demo or judged run, not just
once at feature freeze. `docs/fixtures/nutrient-extract-*` now carries five
real snapshots (Aug 20, Aug 29, three from Sep 3, two of the three identical
and kept as one); a sixth from a later date is the next useful data point,
not a fourth from today.

**Not a credits concern.** The extra `understand`-only re-runs cost roughly
15 credits each against a balance in the hundreds of thousands remaining —
immaterial. The two byte-identical re-runs were kept only in the sense that
they informed this write-up; the fixture files themselves were not committed
twice, since a duplicate fixture would misrepresent five samples as more
independent evidence than they are.

## Committed fixtures from this run

- `docs/fixtures/nutrient-extract-structure-2026-09-03T13-49-50-1e31ab.json`
- `docs/fixtures/nutrient-extract-understand-2026-09-03T13-49-56-64ed9c.json`
- `docs/fixtures/nutrient-extract-agentic-2026-09-03T13-50-09-5a3ad2.json`

## Still open

- Thresholds remain uncalibrated by the project's own definition. A
  representative sample means multiple real document types and multiple real
  documents per type, not repeated runs of one synthetic invoice — that is
  unchanged from Aug 20's assessment.
- Given the demonstrated drift, a single fixed `recognition` floor may not be
  a durable safety mechanism for this document by itself. If time allows past
  this submission, worth asking Jon Addams (who already offered to review
  routing findings — see `docs/nutrient-stage-aug20.md`) whether
  `recognitionScore` is expected to drift this much run-to-run on identical
  input, and whether a relative signal (recognitionScore rank within the
  page, rather than an absolute floor) would be more stable than what this
  adapter does today.
- The recalibration reminder above is process, not code — nothing currently
  forces a re-run before a demo. Worth a one-line note in the demo runbook,
  not a code change, given the time remaining.
