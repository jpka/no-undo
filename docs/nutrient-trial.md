# Nutrient DWS — Trial Context

**Account:** jpkaniefsky@gmail.com
**Trial:** Nutrient DWS API trial (free tier, no credit card)
**Contacts:** Sandeep (trial welcome email, Aug 20); Jon Addams, solutions engineer — engaged with extraction-routing guidance Aug 20 (see `docs/nutrient-support-aug20.md`)
**Dashboard:** dashboard.nutrient.io

## What we're building
**Project:** "No Undo" — DevNetwork API + Cloud + AI Hackathon 2026 submission (deadline Sept 3, 2026).

An agent pipeline that takes a messy input document all the way to a signed output:
1. Nutrient DWS — data extraction; low-confidence / bad-match fields route to a human approval gate. Then PII redaction.
2. Foxit MCP server — assembly, conversion, OCR, merge (all reversible, unattended).
3. Human approval gate on the irreversible eSign send.
4. Foxit eSign API with client-side dedup (folderStatus DRAFT/SHARED reconciliation).

## Nutrient's role (the "meaningfully" bar)
Two capabilities being tested:
- **Data extraction** — `POST /extraction/parse`. Routing per Aug 20 SE guidance: per-field **match label primary** (`fuzzy_match` / `not_found` route to the human unconditionally), composite confidence secondary, thresholds calibrated per document type. Finer signal via `confidenceComponents` (`probabilityScore`, `marginScore`, `groundingScore`, `formatScore`) plus `recognitionScore` for OCR docs.
- **PII redaction** — Processor side. Stage-then-apply flow gives a review checkpoint before signing, same shape as the extraction gate.

## Current status (Aug 20)
- DWS Processor key in `.env` as `NUTRIENT_API_KEY`.
- **BLOCKED on Data Extraction:** `POST /extraction/parse` → 403. Data Extraction is a separately provisioned product. Need `NUTRIENT_DWS_EXTRACTION_API_KEY` from dashboard.nutrient.io. **Escalation path:** Jon Addams, if the dashboard doesn't self-serve.
- Probe ships fixture-ready at `mcp/nutrient/extraction-probe.mjs`; the 403 diagnostic is the committed fixture.
- Routing design revised per SE guidance — `docs/nutrient-support-aug20.md`.

## Key findings
- **Aug 18:** Nutrient DWS has `Idempotency-Key` only on async `POST /build` with `Prefer: respond-async`. `/processor/*` and `/extraction/*` have none. Baseline for Nutrient operations: client-side dedupe via per-operation digest (document SHA-256 + instructions).
- **Aug 20 (Jon Addams, SE):** extraction is stateless request/response — no server-side job state, no resume, no checkpoint. All durability is our state machine's job. Confidence scores are uncalibrated across document types; match labels are the stronger routing signal.
