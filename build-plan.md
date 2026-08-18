# DevNetwork [API + Cloud + AI] Hackathon 2026 — Build Plan
 
**Status:** registered, online phase running. First batch landed Aug 18, ahead of its Aug 18–19 window; the recovered slack is spent on Gate 0 below. Plan revised Aug 18 — see `docs/review-aug18.md`.
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
2. **Nutrient DWS** — data extraction with confidence scores; spans below threshold route to the human. Then PII redaction. *(This is Nutrient's own suggested scenario #5, and it makes DWS load-bearing rather than decorative — which is their stated bar: "for at least one core document operation, meaningfully.")*
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
 
1. **Agent sandboxes cannot reach the vendor APIs.** Verified: `na1.fusion.foxit.com` and `api.nutrient.io` are unreachable from the sandbox; only `registry.npmjs.org` is allowlisted. Every live-API check is **human-run, on your machine**. Subagents write the probe, the adapter and the tests; you execute and paste back the transcript.
2. **Therefore every vendor adapter gets a fixture seam on day one.** Agents test against recorded transcripts. Each stage ships one `node mcp/<vendor>/<stage>-probe.mjs` you run in a single command, with its output committed as the fixture. That is also judge-facing reproducibility for free.
3. **`safe-write-mcp-core` stays its own repo** (it is published; servers A and C consume it) and is checked out alongside `No Undo`. Two PR streams, one `AGENTS.md` workflow. Core v0.2 lands there and is consumed here by version.
4. **Budget the process.** `AGENTS.md` mandates PR → CI → review round → merge for any session that changes files; PR #1 cost one CodeRabbit round. Assume **~40 min per batch**, ~5h across the ~8 remaining batches. That is coding time you do not have — it is counted in the budget below. If it starts hurting, the decision to make is whether `AGENTS.md` should carve out docs-only changes; do not silently skip the ceremony instead.
 
---
 
## Day-by-day
 
**Aug 18–19 — evenings, ~6h. Unblock everything. — ✅ DONE Aug 18, a day early (see `docs/aug18-19.md`)**
- Foxit developer account at `developer-api.foxit.com` (self-serve, instant), Nutrient DWS free tier (no credit card). **Accounts + keys in `.env`.**
- Get Foxit's MCP server running locally against your own client. Confirm the toolset. **Done: `@foxitsoftware/foxit-pdf-api-mcp-server` runs against our keys, 40 tools listed, no signing tool, end-to-end `pdf_from_url` → `get_task_result` smoke test passed.**
- **Verify whether Foxit eSign and Nutrient DWS support idempotency keys.** This blocks the core work below. If eSign has no idempotency header, the fallback is a client-side dedupe ledger keyed on the plan token — decide this before writing code, not during. **Decision locked: Foxit eSign has NO server-side idempotency (billing-only `request_id` dedup; sends deduped by folder `folderStatus DRAFT/SHARED` reconciliation). Nutrient DWS has `Idempotency-Key` only on async `POST /build` with `Prefer: respond-async`; `/processor/*` and `/extraction/*` have none. Baseline = client-side dedupe ledger keyed on plan token for eSign sends; per-operation digest (document SHA-256 + instructions) for Nutrient.**
 
**Aug 19 — ~2h, from the recovered slack. GATE 0: prove eSign exists for us.** ⛔ *blocks everything below*
 
The first batch verified Foxit **PDF Services** live. It verified **nothing** about eSign or Nutrient — §2 and §3 of `docs/aug18-19.md` are spec-reading and blog-reading, excellent but untested. Four load-bearing assumptions are currently unexamined, and the first one can end the project:
 
- **Is our self-serve developer account entitled to eSign at all?** PDF Services and eSign are separately provisioned. Nothing has confirmed our credentials open `/esign/api/v1`. If they do not, "the one irreversible step is a signature send" has no API under it.
- Does `createfolder` accept `sendNow:false` and return a `folderId` synchronously? The entire two-step crash-safe send depends on it.
- Does `GET myfolder` report `folderStatus: DRAFT` for that folder? This is the reconciliation signal `confirmExecuted()` is built around.
- Is there a reachable send-draft route, gateway or legacy? Already flagged as unknown in `docs/aug18-19.md` and wrongly deferred to Aug 23 — it decides whether the two-step flow exists.
 
Run `node mcp/foxit/esign-probe.mjs --create-draft` (sources `.env`; never sends, only drafts). Commit the transcript to `docs/`. **If the entitlement check fails, stop and pick a contingency within the hour — `docs/review-aug18.md` §5.** The pre-written fallback is to re-target the irreversible action at Foxit PDF Services' genuinely destructive tools (`delete`, password-`protect`), which keeps all three entries and every line of core work.
 
Same session, cheap: **a live Nutrient extraction call on one messy page**, confirming the response actually carries per-span confidence scores. The whole Nutrient-track argument is confidence-routed approval, and Data Extraction has no OpenAPI spec — docs only. Also check whether the free-tier key is a *test* key, since async `/build` idempotency is documented as unsupported on test keys.
 
Also this session, 15 minutes: **clone `safe-write-mcp-core` alongside this repo.** The next batch cannot start without it.
 
**Aug 20–22 — ~14h. Core v0.2. The MUST list.**
- Split `consume()` into `beginExecute()` → `confirmExecuted()` / `confirmFailed()`. `"executed"` is only audited after host confirmation. A plan stuck in `executing` past a timeout becomes a queryable state, not a silently forgotten one.
- Durable journal: append-only, fsync'd, one line per token transition, so restart can detect "mid-execute."
- Plan token as documented idempotency key. *(Confirmed Aug 18: eSign has no server key — the ledger IS the idempotency.)*
- **Reconciliation is a host-supplied callback, not a vendor call.** *(Revised Aug 18.)* The original plan had the core implement the two-step eSign send while the gateway-vs-legacy host decision sat in the Aug 23–25 batch — a mis-ordered dependency. The ledger contract is indeed host-independent, but `confirmExecuted()`'s reconciliation is not. So the core takes a `reconcile(token) → 'done' | 'not-done' | 'unknown'` function from the host, exactly like the existing host-supplied `renderPlan` seam. The core then never names a vendor, which is also the portfolio-reuse property the original pitch asked for. Foxit's `folderStatus DRAFT/SHARED` check becomes one implementation of it.
- Core-enforced `dataDigest` re-check.
- Tests for each, against **fixtures from Gate 0**, not the live API. Keep the suite green — 73/73 passing is a credibility asset in the repo.
 
**Aug 23–25 — ~12h. The eSign adapter and agent loop.**
Prompt → document → proposed send. Foxit MCP for the reversible work, your gate on the send. Implements the `reconcile` callback against whichever host Gate 0 confirmed. Includes the **webhook dedup on `(folderId, event_name)`** that `docs/aug18-19.md` identified and no day previously owned.
 
**Aug 26–28 — ~12h. Nutrient stage.**
Extraction with confidence thresholds routing low-confidence spans to the same approval gate, then redaction. Reuse one approval UI for both decisions — that unity is the design argument.
 
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
 
- Apptio, useBruno, and Wundergraph have not published their challenges. Wundergraph (GraphQL federation gateway) is the one most likely to fit a "safe write gateway" story. Re-check `/details/sponsors` around Aug 25 — a fourth free track is worth ten minutes of checking.
- Foxit's listed contact email on the sponsor page has a typo (`...foxitsoftware.come`). Use the developer portal if you need support.
- Team size is 1–5. Solo is fine; a second person on the demo video would not hurt.