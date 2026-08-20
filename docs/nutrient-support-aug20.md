# Nutrient support thread — Aug 20, 2026

**Contact:** Jon Addams, Solutions Engineer, Nutrient. Thread started by Sandeep's trial welcome email; Jon took it over after our reply describing the project.
**What we told them:** No Undo — a crash-safe approval gate around an irreversible eSign send, with DWS doing extraction-with-confidence routing and PII redaction, for the DevNetwork hackathon (deadline Sept 3).

## The guidance, distilled

1. **Route on the match label first, confidence second.** Every extracted field from the extract endpoint carries a match label (`id_match`, `id_match_multiblock`, `id_match_partial`, `fuzzy_match`, `not_found`) alongside the composite confidence score. Nutrient's own guidance: `fuzzy_match` and `not_found` go straight to human review **regardless of the confidence number**; confidence is a secondary, tie-breaking signal on top.
2. **Confidence is relative and uncalibrated — not a probability.** A 0.82 on one document type is not comparable to a 0.82 on another, and confidently-wrong results are possible even in the highest-accuracy mode. A single global threshold will behave inconsistently across document types. Calibrate per document type against a representative sample of real documents.
3. **`confidenceComponents` gives finer signal than the composite.** Per field: `probabilityScore`, `marginScore`, `groundingScore`, `formatScore`, plus a separate `recognitionScore` for OCR quality on non-born-digital docs. Example: route on `groundingScore` when the gate should care whether a value was actually found in the document vs inferred.
4. **Extraction is stateless.** No server-side job state, no resume, no checkpoint. The crash-safety guarantee (no double-send, honest audit log) is entirely our state machine's responsibility around the call. Jon flagged this explicitly so we don't go looking for a resume feature that doesn't exist. For the demo narrative this is a gift: Nutrient's own SE confirms the safety net is the thing we built, not something the API provides.
5. **Threshold tuning: sample across modes, not doc numbers.** Run a representative sample of our actual documents through each mode (structure vs understand vs agentic) and record where `fuzzy_match` / `not_found` / low-confidence rates land per mode. Jon would not give a target accuracy number; it genuinely varies by document type and mode.
6. **Redaction has a stage-then-apply flow.** On the Processor side, AI-assisted and pattern-based redaction can be staged, then applied. Worth a review checkpoint before signing, same shape as the extraction gate. This strengthens the "one approval UI for both decisions" unity argument.

## Offers on the table

- Jon will look at specific extraction responses where routing felt wrong — send the `confidenceComponents` breakdown on the case.
- He pointed us at the stage-then-apply redaction flow for review before signing.

## What this changes

- Routing design: match label primary, confidence secondary, per-type calibration. Was: a global confidence threshold. (Build plan Aug 26–28 revised Aug 20.)
- Calibration becomes an explicit step in the Nutrient stage: representative sample x three modes, record match-label rates before locking thresholds.
- Redaction: use stage-then-apply so redaction gets its own review checkpoint on the same approval UI.
- Stateless extraction confirms the Aug 18 decision: per-operation digest dedup on our side; nothing to reconcile server-side for extraction.
- **The blocker stands.** Data Extraction entitlement still 403s on the Processor key. But Jon is now the escalation path if the dashboard doesn't self-serve the extraction key.

## Verbatim email

> Hi Juan,
>
> Great project — a crash-safe approval gate around an irreversible e-sign step is exactly the kind of thing that's easy to get wrong, so I'm glad to dig in on this with you.
>
> On the "confidence score routing pattern": what you're doing is the pattern we point to as extraction feeding a human-in-the-loop approval step (we've documented this pairing before as extraction -> approvals/routing, usually with a workflow tool on the back end, but your own gate works exactly the same way conceptually). A few specifics that should help as you tune it:
>
> 1. Match Labels: Don't route on the confidence number alone. Each extracted field on the extract endpoint carries a match label (id_match, id_match_multiblock, id_match_partial, fuzzy_match, not_found) alongside the composite confidence score. That label is actually the stronger signal - our own guidance is to route fuzzy_match and not_found straight to human review regardless of the confidence number, and use confidence as a secondary/tie-breaking signal on top of that.
>
> 2. Confidence Scores: The confidence score itself is relative and uncalibrated, not a probability. A 0.82 on one document type isn't necessarily comparable to a 0.82 on another, and a confidently-wrong result is possible even in our highest-accuracy mode. So if you're hardcoding a single global threshold (e.g. "anything under 0.9 goes to review"), expect it to behave inconsistently across document types until you calibrate it against a representative sample of your actual documents. That's basically what you're running into with "whether the routing pattern feels natural or forced" - it's less about the pattern and more about tuning the threshold per document type.
>
> 3. Confidence Components: If you want more signal than the single composite score, there's a confidenceComponents breakdown per field (probabilityScore, marginScore, groundingScore, formatScore) plus a separate recognitionScore for OCR quality on non-born-digital docs. Useful if you want your gate logic to be smarter than a single cutoff - e.g. route on groundingScore specifically if you care whether the value was actually found in the document vs. inferred.
>
> 4. Crash Recovery: One thing worth being explicit about for your crash-recovery story: extraction itself is a stateless request/response call - there's no server-side job state to recover on our end. So the durability guarantee you're building (no double-send, no lying audit log on restart) is entirely your own state machine's responsibility around the call, not something the API does for you. That's the right way to think about it - just flagging so you're not looking for a resume/checkpoint feature on the extraction side, because there isn't one to find.
>
> On thresholds with real documents: I can't give you a target accuracy number responsibly - it genuinely varies by document type and mode. The recommended approach (and what I'd do here) is to run a representative sample of your actual documents through each mode (structure vs. understand vs. agentic) and see where the fuzzy_match/not_found/low-confidence rate lands for your specific content, rather than assuming one mode's numbers from our docs will hold for your documents.
>
> Happy to look at specific extraction responses if you hit something that looks off - be useful to see the confidenceComponents breakdown on a case where the routing felt wrong. And whenever you get to the redaction step, the AI-assisted and pattern-based redaction on the Processor side has a stage-then-apply flow that might be worth reviewing before it hits signing, in case you want a similar review checkpoint there.
>
> Good luck with the hackathon submission - this is a solid problem to build around.
>
> Best regards,
> Jon Addams
