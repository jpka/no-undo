# DevNetwork [API + Cloud + AI] Hackathon 2026 — Build Plan
 
**Status:** registered, online phase running. First batch landed Aug 18 (ahead of its window); **Gate 0 landed Aug 18 — eSign 5/5 PASS, Nutrient Data Extraction blocked on a missing product key** (see `docs/gate0-aug18.md`). Plan revised Aug 18 (`docs/review-aug18.md`). **Aug 20: Nutrient solutions engineer (Jon Addams) engaged with extraction-routing guidance — match labels over raw confidence thresholds, extraction confirmed stateless, redaction has a stage-then-apply review flow (see `docs/nutrient-support-aug20.md`). Nutrient stage revised Aug 20.**
**Hard deadline:** Sept 3, 2026, 10:00am PDT = **2:00pm Argentina time**. Not "end of day Sept 3."
**Time budget assumed:** ~60 hours (a few full days plus evenings) across Aug 18 – Sep 2. *Revised Aug 18: the day-by-day now sums to ~62h of coding plus ~5h of PR/review overhead plus an unestimated Aug 31 freeze day — call it **~70h against a ~60h budget**. The gap is real. It is absorbed by the cut list, which is why the cut list is ordered and why the never-cut items are only two.*
**Tracks targeted:** Foxit + Nutrient DWS + Overall. One project, three entries — the rules explicitly allow entering as many challenges as you want, and allow stacking sponsor prizes with Overall.
 
---
 
## What changed since the original pitch
 
The original pitch named **Nutrient + Doctavian**, and aimed them at portfolio projects #1 (RAG) and #3 (triage agent), neither of which is built. Two things have moved since:
 
1. **Foxit published its challenge** (it was "coming soon" at the time of that pitch). It is titled *"Your Agent Shouldn't Sign That"* and it is, almost verbatim, the safe-write pattern: their open-source MCP server exposes ~40 tools for *reversible* document work and **deliberately excludes signing**; to actually sign, the agent must cross a boundary into the eSign API and a human must be involved. **The design of that agent→human handoff is the graded artifact.** That is a better fit than Doctavian and it fits something you have already built.
2. **Servers A and C are done, and the core is already extracted** (`jpka/safe-write-mcp-core`). The fastest credible submission is no longer "build the RAG project"; it's "point the existing kernel at an irreversible action."
 
The original pitch's architectural warning still stands and is now nearly free: *keep the vendor behind an interface so the portfolio version can swap it out.* `safe-write-mcp-core` already has that seam — preview logic is host-supplied, the core only owns the plan lifecycle. Foxit and Nutrient become adapters, not dependencies.
 
**Doctavian is dropped.** Its brief overlaps Foxit's (agent → generated document → signature) but Foxit's is the one that grades the safety boundary, and doing both would split the demo.
 
---
 
## The submission
 
**One sentence:** an agent that goes from a plain prompt to a signed document, where every reversible step runs unattended and the one irreversible step — sending for signature — is stopped at a human approval gate that survives a process crash without double-sending.
 
**Pipeline:**
 
1. Messy input document in.
2. **Nutrient DWS** — data extraction; routing decided on the per-field match label first (`fuzzy_match` / `not_found` go to the human regardless of the confidence number), composite confidence second, thresholds calibrated per document type (Aug 20 Nutrient SE guidance, `docs/nutrient-support-aug20.md`). Then PII redaction via the stage-then-apply flow, so redaction gets the same review checkpoint. *(This is Nutrient's own suggested scenario #5, and it makes DWS load-bearing rather than decorative — which is their stated bar: "for at least one core document operation, meaningfully.")*
3. **Foxit's MCP server** — assembly, conversion, OCR, merge. All reversible, all unattended, using their published toolset as intended.
4. **The gate.** Agent proposes an eSign send. The plan preview shows recipients, document digest, and an explicit irrevocability warning. Human approves or rejects.
5. **Foxit eSign API** called directly with **client-side dedup**: the plan token keys a durable ledger, and a `folderStatus` reconciliation (DRAFT vs SHARED) ensures the send happens exactly once — then a hash-chained append-only audit record.
 
**Why this can win Overall, not just a sponsor track.** Overall is judged on Progress, Concept, and Feasibility. Concept: agents are being handed write access to systems where actions cannot be undone, and the industry's answer is "add a confirmation prompt." Feasibility: this is already two shipped servers and a published npm core — the commercial story is not hypothetical, it's your Upwork listing.
 
---
 
## The technical finding that becomes the story
 
A subagent read the whole core (73 tests, all passing, clean build) and found one gap that matters here, and it is worth understanding precisely because it's both a real bug and the best narrative you have.
 
`consume()` is **causally disconnected from the external side effect**. It flips `entry.used = true` and emits an `"executed"` audit event, and then returns — the host makes the actual API call somewhere the core cannot see. Both orderings fail on a crash:
 
- **Consume, then call:** process dies in between → audit log says the document was sent; it wasn't. Silent under-execution with a lying audit trail.
- **Call, then consume:** process dies in between → the signer already has the email, the core never recorded it, the plan store is in-memory so a restart forgets the token entirely, and a retry **re-sends the document**.
 
`DECISIONS.md` defends the in-memory store on the grounds that "a restart invalidates all pending plans, so nothing executes without re-previewing, which is exactly the safe direction." **That reasoning is correct for Postgres and exactly backwards here.** With rollback available, the dangerous window is before execution. With a send-and-you-can't-unsend API, the dangerous window straddles the call — which the core does not model at all.
 
Also: no idempotency-key contract, no persisted state, `dataDigest` is advisory rather than core-enforced (so a payload referencing a `documentId` passes fingerprint validation even if the document behind it changed — a TOCTOU hole precisely where the document content is the entire risk surface).
 
**This is the demo.** Not the happy path. The 30 seconds that wins is: kill the process mid-send, restart it, show it does not double-send and the audit log is honest about what happened. Nobody else in this hackathon will demo a crash.
 
---
 
## Working constraints (added Aug 18 after the first batch — read before delegating)
 
1. **Agent sandboxes cannot reach the vendor APIs — *unless the sandbox runs on a networked machine*.** Verified in the Aug 18 sandbox: `na1.fusion.foxit.com` and `api.nutrient.io` were unreachable; only `registry.npmjs.org` was allowlisted. **Gate 0 (Aug 18) ran from a networked machine where all three hosts answered** — live probes were executed directly and their transcripts committed. Rule: *test connectivity first; if the host answers, execute and commit the transcript; if not, hand the probe to the human.* Every live-API check remains either way.
2. **Therefore every vendor adapter gets a fixture seam on day one.** Agents test against recorded transcripts. Each stage ships one `node mcp/<vendor>/<stage>-probe.mjs` you run in a single command, with its output committed as the fixture. That is also judge-facing reproducibility for free.
3. **`safe-write-mcp-core` stays its own repo** (it is published; servers A and C consume it) and is checked out alongside `No Undo`. Two PR streams, one `AGENTS.md` workflow. Core v0.2 lands there and is consumed here by version.
4. **Budget the process.** `AGENTS.md` mandates PR → CI → review round → merge for any session that changes files; PR #1 cost one CodeRabbit round. Assume **~40 min per batch**, ~5h across the ~8 remaining batches. That is coding time you do not have — it is counted in the budget below. If it starts hurting, the decision to make is whether `AGENTS.md` should carve out docs-only changes; do not silently skip the ceremony instead.
 
---
 
## Day-by-day
 
**Aug 18–19 — evenings, ~6h. Unblock everything. — ✅ DONE Aug 18, a day early (see `docs/aug18-19.md`)**
- Foxit developer account at `developer-api.foxit.com` (self-serve, instant), Nutrient DWS free tier (no credit card). **Accounts + keys in `.env`.**
- Get Foxit's MCP server running locally against your own client. Confirm the toolset. **Done: `@foxitsoftware/foxit-pdf-api-mcp-server` runs against our keys, 40 tools listed, no signing tool, end-to-end `pdf_from_url` → `get_task_result` smoke test passed.**
- **Verify whether Foxit eSign and Nutrient DWS support idempotency keys.** This blocks the core work below. If eSign has no idempotency header, the fallback is a client-side dedupe ledger keyed on the plan token — decide this before writing code, not during. **Decision locked: Foxit eSign has NO server-side idempotency (billing-only `request_id` dedup; sends deduped by folder `folderStatus DRAFT/SHARED` reconciliation). Nutrient DWS has `Idempotency-Key` only on async `POST /build` with `Prefer: respond-async`; `/processor/*` and `/extraction/*` have none. Baseline = client-side dedupe ledger keyed on plan token for eSign sends; per-operation digest (document SHA-256 + instructions) for Nutrient.**
 
**Aug 19 — ~2h, from the recovered slack. GATE 0: prove eSign exists for us.** ✅ DONE Aug 18, a day early (recovered slack pulled it in, like the first batch) — see `docs/gate0-aug18.md`, fixtures in `docs/fixtures/`.

- **Foxit eSign: 5/5 PASS.** Entitled (HTTP 200), `createfolder(sendNow:false)` returns `folderId`, `folderStatus` confirms `DRAFT`, and a **send-draft route exists on the gateway** — **locked as the send host** (same `client_id`/`client_secret` headers, no OAuth token). Legacy host exists as fallback. eSign shares the PDF Services credential pair. **Aug 20–22 core work proceeds.**
- **Nutrient Data Extraction: BLOCKED.** `POST /extraction/parse` → **403**: Data Extraction is a separately provisioned product; our DWS Processor key is not entitled. **UNBLOCK (human, ~5 min): add `NUTRIENT_DWS_EXTRACTION_API_KEY` to `.env` from dashboard.nutrient.io.** Probe ships fixture-ready (`node mcp/nutrient/extraction-probe.mjs`); the 403 diagnostic is the committed fixture. Key is `pdf_live_` = **live**, so the async-`/build`-test-key caveat does not apply.
- **`safe-write-mcp-core` cloned** at `../safe-write-mcp-core`. Critical-path repo is in place.
 
**Aug 20–22 — ~14h. Core v0.2. The MUST list.** ✅ DONE Aug 19, a day early — see `safe-write-mcp-core` [PR #15](https://github.com/jpka/safe-write-mcp-core/pull/15) (`Closes #14`), merged as `0cbe5e7`.
- Split `consume()` into `beginExecute()` → `confirmExecuted()` / `confirmFailed()`. `"executed"` is only audited after host confirmation. A plan stuck in `executing` past a timeout becomes a queryable state, not a silently forgotten one. **Done**: `consume()` kept as a documented, explicitly-not-crash-safe legacy wrapper; `listExecuting()` surfaces stuck plans.
- Durable journal: append-only, fsync'd, one line per token transition, so restart can detect "mid-execute." **Done**: `src/journal.ts`, streamed replay (no whole-file read), 0o600 perms, parent-directory fsync so a fresh journal survives a power loss, broken-descriptor guard on partial/serialize write failures.
- Plan token as documented idempotency key. *(Confirmed Aug 18: eSign has no server key — the ledger IS the idempotency.)* **Done**, documented on `PlanCreated`/`beginExecute`.
- **Reconciliation is a host-supplied callback, not a vendor call.** *(Revised Aug 18, send host locked Aug 18.)* The ledger contract is host-independent, but `confirmExecuted()`'s reconciliation is not. The core takes a `reconcile(token) → 'done' | 'not-done' | 'unknown'` function from the host. Foxit's implementation is the **gateway** `folderStatus DRAFT/SHARED` check via `GET /esign/api/v1/folders/myfolder?folderId=`, confirmed reachable in Gate 0 (legacy host is the fallback). **Core done**: `PlanStoreOptions.reconcile`, bounded by `reconcileTimeoutMs` so a hanging host hook can't stall recovery. The Foxit-specific `reconcile` implementation still lands with the eSign adapter (Aug 23–25).
- Core-enforced `dataDigest` re-check. **Done**: `beginExecute()` fails closed with `DATA_DIGEST_MISMATCH`.
- Tests for each, against **fixtures from Gate 0**, not the live API. Keep the suite green — 73/73 passing is a credibility asset in the repo. **Done**: 108/108 passing (73 pre-existing + 35 new).

*Delegated to `opencode run -m opencode/deepseek-v4-flash-free` across three rounds (initial implementation, then two CodeRabbit review-fix rounds), reviewed and merged by Claude Code.*
 
**Aug 23–25 — ~12h. The eSign adapter and agent loop.** ✅ DONE Aug 20, three days early — see PR #7 (`feat/esign-mcp-server-and-agent`).
- MCP server (`mcp/foxit/esign-mcp-server.mjs`) exposes the crash-safe lifecycle as tools: `esign_create_draft`, `esign_begin_send`, `esign_confirm_executed`, `esign_confirm_failed`, `esign_list_executing`, `esign_reconcile`.
- Approval server runs **in-process** (shares the PlanStore), with a custom `renderPlan` hook: folder name + recipient list + explicit irrevocability warning — NOT `JSON.stringify` on the raw payload (which would leak PII).
- Custom renderPlan hook renders recipients + folder name + irrevocability warning instead of the core's `JSON.stringify` default.
- Fixed `beginEsignSend` to require the payload explicitly (core can't reconstruct it from the journal).
- Fixed `confirmFailed` to refuse when folder status is already SHARED (prevents double-send).
- Fixed `loadEsignStore` to not depend on missing `PlanStore.fromJournal` (constructor already replays the journal).
- 7/7 tests pass against Gate 0 fixtures (no live API).
- Fixed broken import path (`src/index.js` → correct `dist/index.js` relative path).
 
**Aug 26–28 — ~12h. Nutrient stage.** *(Prereq added Aug 18: Data Extraction key in `.env` as `NUTRIENT_DWS_EXTRACTION_API_KEY` — the current key is Processor-only and 403s on `/extraction/parse`.)*
Extraction routing per the Aug 20 Nutrient SE guidance (`docs/nutrient-support-aug20.md`): the per-field **match label is the primary signal** — `fuzzy_match` and `not_found` route to the human unconditionally; composite confidence is a secondary tie-breaker, calibrated per document type against a representative sample (the score is relative and uncalibrated, so no single global cutoff). Use `confidenceComponents.groundingScore` when the gate should distinguish "found in the document" from "inferred." Calibration is an explicit step: run the representative sample through each mode (structure / understand / agentic) and record where `fuzzy_match` / `not_found` / low-confidence rates land per mode before locking thresholds. Extraction is stateless request/response (confirmed by Nutrient SE) — no server-side job state to resume, so retry dedup stays the per-operation digest decided Aug 18. Then redaction, using the Processor **stage-then-apply** flow so redaction gets its own review checkpoint. Reuse one approval UI for both decisions — that unity is the design argument. First run of `node mcp/nutrient/extraction-probe.mjs` once the key lands; the fixture and probe already ship from Gate 0.
 
**Aug 29–30 — ~8h. Audit and UI.**
Hash-chained JSONL sink with `prevHash`. Approval page that renders the document and the recipient list, not `JSON.stringify`. Drop raw `payload` from `GET /api/plans` — right now a host's careful `renderPlan` redaction is silently bypassed by that endpoint, which is embarrassing in a PII demo.
 
**Aug 31 — feature freeze.** README, architecture diagram, setup instructions that a judge can actually follow.
 
**Sep 1–2 — ~8h.** Demo video, 2–4 min, crash shot included. Devpost project page. Enter it to Foxit, Nutrient, and Overall. One line each on where their API did the real work.
 
**Sep 3, before 2pm ART.** Submit. Not at 1:55.
 
**Cut list, in order, if time runs short:** N-of-M approval → approval-server authentication → Nutrient redaction (keep extraction-with-confidence, which is enough to satisfy "meaningfully") → the polished approval UI. **Never cut:** the crash-safety fix or the demo video.
 
**Contingency, if Gate 0 says eSign is not available to us** *(added Aug 18; full version in `docs/review-aug18.md` §5)*. Decide within one hour, ranked:
1. Separate eSign trial signup, if one exists. Changes nothing else.
2. **Re-target the irreversible action at PDF Services' destructive tools** — `delete` of an uploaded document, password-`protect`. Practically irreversible, still squarely on-brief for a challenge titled *"Your Agent Shouldn't Sign That"*, keeps all three entries and reuses every line of core work. This is the one to reach for.
3. Nutrient-only plus Overall, with the gate on redaction (destructive by construction). Drops the Foxit track.
 
---
 
## Carry-over value
 
Everything here is an asset you needed anyway:
 
- `safe-write-mcp-core` v0.2 is strictly better after this, and A and C both inherit the fix — **A currently has this same crash-safety gap** in any deployment where the write isn't purely transactional.
- The demo video is the Loom your Upwork Project Catalog gallery is blocked on. "Rejected deletion, agent adapts" becomes "rejected signature, agent adapts."
- A public Devpost page and a judged placement is third-party proof your listing cannot otherwise buy.
- Three shipped servers on one core reads as a designed pattern. Two reads as two one-offs.
 
---
 
## Open items

- **⚠ Human action (unblocks Aug 26–28): get a Nutrient Data Extraction API key** at `dashboard.nutrient.io` and add it to `.env` as `NUTRIENT_DWS_EXTRACTION_API_KEY`. The existing `NUTRIENT_API_KEY` is DWS-Processor-only (403 on `/extraction/parse`). Then run `node mcp/nutrient/extraction-probe.mjs` and commit the transcript. *This is the only open blocker; it does not hold up Aug 20–22 core work.* **Escalation path added Aug 20:** Jon Addams (Nutrient solutions engineer) is engaged on this exact pipeline — if the dashboard does not self-serve the extraction entitlement, reply to him directly; he has context and has offered to review extraction responses.
- Apptio, useBruno, and Wundergraph have not published their challenges. Wundergraph (GraphQL federation gateway) is the one most likely to fit a "safe write gateway" story. Re-check `/details/sponsors` around Aug 25 — a fourth free track is worth ten minutes of checking.
- Foxit's listed contact email on the sponsor page has a typo (`...foxitsoftware.come`). Use the developer portal if you need support.
- Two eSign probe drafts (`35426242`, `35426627`) are sitting in the eSign dashboard, unsent — delete when convenient.
- Team size is 1–5. Solo is fine; a second person on the demo video would not hurt.