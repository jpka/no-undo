# DevNetwork [API + Cloud + AI] Hackathon 2026 — Build Plan
 
**Status:** registered, online phase running.
**Hard deadline:** Sept 3, 2026, 10:00am PDT = **2:00pm Argentina time**. Not "end of day Sept 3."
**Time budget assumed:** ~60 hours (a few full days plus evenings) across Aug 18 – Sep 2.
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
2. **Nutrient DWS** — data extraction with confidence scores; spans below threshold route to the human. Then PII redaction. *(This is Nutrient's own suggested scenario #5, and it makes DWS load-bearing rather than decorative — which is their stated bar: "for at least one core document operation, meaningfully.")*
3. **Foxit's MCP server** — assembly, conversion, OCR, merge. All reversible, all unattended, using their published toolset as intended.
4. **The gate.** Agent proposes an eSign send. The plan preview shows recipients, document digest, and an explicit irrevocability warning. Human approves or rejects.
5. **Foxit eSign API** called directly with an idempotency key, then a hash-chained append-only audit record.
 
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
 
## Day-by-day
 
**Aug 18–19 — evenings, ~6h. Unblock everything. — ✅ DONE (see `docs/aug18-19.md`)**
- Foxit developer account at `developer-api.foxit.com` (self-serve, instant), Nutrient DWS free tier (no credit card). **Accounts + keys in `.env`.**
- Get Foxit's MCP server running locally against your own client. Confirm the toolset. **Done: `@foxitsoftware/foxit-pdf-api-mcp-server` runs against our keys, 40 tools listed, no signing tool, end-to-end `pdf_from_url` → `get_task_result` smoke test passed.**
- **Verify whether Foxit eSign and Nutrient DWS support idempotency keys.** This blocks the core work below. If eSign has no idempotency header, the fallback is a client-side dedupe ledger keyed on the plan token — decide this before writing code, not during. **Decision locked: Foxit eSign has NO server-side idempotency (billing-only `request_id` dedup; sends deduped by folder `folderStatus DRAFT/SHARED` reconciliation). Nutrient DWS has `Idempotency-Key` only on async `POST /build` with `Prefer: respond-async`; `/processor/*` and `/extraction/*` have none. Baseline = client-side dedupe ledger keyed on plan token for eSign sends; per-operation digest (document SHA-256 + instructions) for Nutrient.**
 
**Aug 20–22 — ~14h. Core v0.2. The MUST list.**
- Split `consume()` into `beginExecute()` → `confirmExecuted()` / `confirmFailed()`. `"executed"` is only audited after host confirmation. A plan stuck in `executing` past a timeout becomes a queryable state, not a silently forgotten one.
- Durable journal: append-only, fsync'd, one line per token transition, so restart can detect "mid-execute."
- Plan token as documented idempotency key. *(Confirmed Aug 18: eSign has no server key — the ledger IS the idempotency. Two-step eSign send (`createfolder(sendNow:false)` → persist token→folderId → send → reconcile `folderStatus`), per `docs/aug18-19.md`.)*
- Core-enforced `dataDigest` re-check.
- Tests for each. Keep the suite green — 73/73 passing is a credibility asset in the repo.
 
**Aug 23–25 — ~12h. The eSign adapter and agent loop.**
Prompt → document → proposed send. Foxit MCP for the reversible work, your gate on the send.
 
**Aug 26–28 — ~12h. Nutrient stage.**
Extraction with confidence thresholds routing low-confidence spans to the same approval gate, then redaction. Reuse one approval UI for both decisions — that unity is the design argument.
 
**Aug 29–30 — ~8h. Audit and UI.**
Hash-chained JSONL sink with `prevHash`. Approval page that renders the document and the recipient list, not `JSON.stringify`. Drop raw `payload` from `GET /api/plans` — right now a host's careful `renderPlan` redaction is silently bypassed by that endpoint, which is embarrassing in a PII demo.
 
**Aug 31 — feature freeze.** README, architecture diagram, setup instructions that a judge can actually follow.
 
**Sep 1–2 — ~8h.** Demo video, 2–4 min, crash shot included. Devpost project page. Enter it to Foxit, Nutrient, and Overall. One line each on where their API did the real work.
 
**Sep 3, before 2pm ART.** Submit. Not at 1:55.
 
**Cut list, in order, if time runs short:** N-of-M approval → approval-server authentication → Nutrient redaction (keep extraction-with-confidence, which is enough to satisfy "meaningfully") → the polished approval UI. **Never cut:** the crash-safety fix or the demo video.
 
---
 
## Carry-over value
 
Everything here is an asset you needed anyway:
 
- `safe-write-mcp-core` v0.2 is strictly better after this, and A and C both inherit the fix — **A currently has this same crash-safety gap** in any deployment where the write isn't purely transactional.
- The demo video is the Loom your Upwork Project Catalog gallery is blocked on. "Rejected deletion, agent adapts" becomes "rejected signature, agent adapts."
- A public Devpost page and a judged placement is third-party proof your listing cannot otherwise buy.
- Three shipped servers on one core reads as a designed pattern. Two reads as two one-offs.
 
---
 
## Open items
 
- Apptio, useBruno, and Wundergraph have not published their challenges. Wundergraph (GraphQL federation gateway) is the one most likely to fit a "safe write gateway" story. Re-check `/details/sponsors` around Aug 25 — a fourth free track is worth ten minutes of checking.
- Foxit's listed contact email on the sponsor page has a typo (`...foxitsoftware.come`). Use the developer portal if you need support.
- Team size is 1–5. Solo is fine; a second person on the demo video would not hurt.