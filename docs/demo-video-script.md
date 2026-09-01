# Demo Video Script — No Undo

> **This is a shooting spec for the target state, not a description of what runs today.**
> Several beats depend on code that is not written yet. The prerequisite gate below lists
> every one. Do not record a beat whose prerequisites are unmet — a judge can clone this
> repo and check, and the showcase page invites them to.
>
> Companion artifact: `docs/showcase.html`, which operates under the opposite rule — it is
> judge-facing and asserts only what is true at publish time.

**Target length:** ~3:45 (confirm against the official rules first — see P9)
**Format:** Screen recording + voiceover, 1080p
**Stories:** (1) Three modes, three failure shapes, (2) Crash without double-send
**Tone:** Calm, technical, no hype. Show, don't tell. Volunteer the gaps.

---

## Do not record until

| # | Prerequisite | Unblocks | Status |
|---|---|---|---|
| P0 | **Make `jpka/no-undo` public.** `gh repo view` reports `isPrivate: true`; anonymous fetch 404s. | Final card, footer link | ☐ |
| P1 | ~~Fix `agent/esign-agent-loop.mjs`. It is a stub: line 99 resolves the server to `agent/esign-mcp-server.mjs` (real path `mcp/foxit/esign-mcp-server.mjs`), it imports `startApprovalServer` and never calls it, and it returns `awaiting_approval` without ever executing, crashing, or reconciling.~~ | All of Story 2 | ✅ **DONE** — `agent/esign-agent-loop.mjs` is no longer a stub: it resolves `mcp/foxit/esign-mcp-server.mjs`, calls `startApprovalServer` to bind the approval server, and drives the full approve → execute → pollUntilSigned → downloadSignedDocument lifecycle. |
| P2 | JSONL audit sink with `prevHash`. There is **no audit sink at all** — core ships a `NoopSink` and the host sinks print one line to stderr. | Audit-trail beat | ✅ **DONE** — `mcp/lib/jsonl-audit-sink.mjs`: both stages append fsync'd, hash-chained records beside their journals (`{journalDir}/{esign,redaction}-audit.jsonl`); `verifyAuditChain()` streams and names the tampered line; torn tails are truncated on recovery. Tested in `test/audit-sink.test.mjs`. Safe to screen-record: events carry no payloads. |
| P3 | Deterministic crash injection — an env flag that exits immediately after `beginExecute` fsyncs. Hand-timed `kill -9` is not reproducible. | The money shot | ✅ **DONE** — `NO_UNDO_CRASH_AFTER_FSYNC=1` (or an exact plan token) SIGKILLs inside `beginEsignSend` between the journal fsync and the gateway call (`maybeCrashAfterFsync`, `mcp/foxit/esign-adapter.mjs`). Spawn-tested; Branch A/B recording = set flag, run, restart. |
| P4 | ~~One real send to your own address, producing the missing `SHARED` fixture. No send has ever succeeded; `folderStatus: SHARED` has never been observed.~~ | Exactly-once branch | ✅ **DONE** — a real send has been exercised end to end — the local audit chain contains five 'executed' records and a signed document was downloaded. |
| P5 | ~~Wire one real Foxit PDF merge into draft creation. Today the eSign path uses a hardcoded base64 stub — `esign-adapter.mjs:391`: `// In production this would come from the Foxit MCP's assembly tools.`~~ | Architecture claim | ✅ **DONE** — `mcp/foxit/pdf-assembly.mjs` renders `buildInvoiceHtml(payload)` → `pdf_from_html` → `get_task_result` via `call-tool.mjs` stdio; `esign-adapter.mjs:createEsignFolder` now uses the assembled bytes + `sha256Base64` → `extra.documentSha256`. Falls back to `TINY_PDF` only with `NO_FOXIT_MCP=1` / missing creds. Tested in `test/pdf-assembly.test.mjs`. |
| P6 | ~~Chain Nutrient → eSign onto one PlanStore. They are currently independent servers with independent stores.~~ | Cold open | ✅ **DONE (Foxit-only single pipeline; Nutrient enrichment optional)** — `agent/esign-agent-loop.mjs:runFromPrompt` parses the prompt, optionally enriches via `enrichWithNutrient` (reversible, before gate) when `NUTRIENT_API_KEY` + `NUTRIENT_DWS_EXTRACTION_API_KEY` are present, then reuses the same `PlanStore` + approval queue for `createEsignFolder` → gate → `sendDraftFolder`. Without Nutrient keys the same path reproduces with a single Foxit credential pair (judged Foxit track). Approval card surfaces `nutrientSummary` + `promptExcerpt`. Tested via `test/agent-loop.test.mjs` enrichment + Foxit-only paths. |
| P7 | Capture a real staged-vs-applied redaction artifact. The byte-size table in `docs/nutrient-stage-aug20.md` has no committed fixture; those tests mock `fetch`. | Redaction beat | ☐ |
| P8 | Fix `.github/workflows/ci.yml` — it runs 1 of 4 test files, so the full suite is a local claim. | Test-count claim | ✅ **DONE** — CI now runs `npm test` (the full glob; 233 tests). |
| P9 | Pull and commit the **actual** hackathon rules. The repo contains no rules, no Devpost URL, no rubric, no stated video limit. Every runtime number in this repo is self-imposed. | Runtime target | ✅ **DONE** — Devpost page at https://api-cloud-ai-hackathon-2026.devpost.com/ ; rules reference https://api-cloud-ai-hackathon-2026.devpost.com/rules ; judging criteria are Progress / Concept / Feasibility ; deadline Sep 3, 2026 @ 1:00pm EDT (10:00am PDT = 2:00pm Argentina time). Committed as `docs/hackathon-rules.md`. |

**Recording logistics:** the approval UI has **no fixed port**. `approvalServer.js` uses
`options.port ?? 0` and neither server passes one, so the OS assigns an ephemeral port
printed to stderr. You cannot pre-open a bookmarked tab; read the port off the terminal.

**Do not screen-record a raw journal file.** The journal record carries the full `payload`.

---

## Cold open (0:00–0:15) — the prompt

*P6 shipped — Foxit-only cold open works now; Nutrient enrichment when keys present.*

**Visual:** Terminal, clean dark theme. Someone types a single line:

```
> Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.
```

**VO:** "One prompt. Everything downstream is reversible until exactly one step, and that
step can't be undone. This is what we put in front of it."

**Visual:** Title card.

```
No Undo — an agent approval gate for irreversible actions
DevNetwork [API + Cloud + AI] Hackathon 2026
```

---

## Story 1 (0:15–1:30) — three modes, three failure shapes

All three responses are committed fixtures from live billed calls, seconds apart. Show the
request IDs and the credit balance dropping — that is the proof they are real.

**Visual:** The invoice. Highlight `Total due $86.86` and `Tax (7.25%) $5.87`.

**VO:** "A freight invoice. Eighty-six eighty-six, tax five eighty-seven. We generated this
document ourselves and made it deliberately hard — scan skew, OCR-hostile glyphs. Then we
sent it to Nutrient's extraction API three times, in its three modes, one after another."

> **Say "we generated this document." Do not say "not a synthetic test."**
> The *calls* were live and billed. The *document* is synthetic —
> `mcp/nutrient/messy-pdf.mjs:60–70` hardcodes the very strings on screen. The live evidence
> is the request IDs and the credit draw-down, and that evidence is strong enough on its own.

### Act 1 — `structure` (cheapest, 7.5 credits, 1.1s)

**Visual:**
```json
{ "total_amount": 0, "match": "not_found", "confidence": 0.577, "groundingScore": 0.40 }
```

**VO:** "The cheapest mode returned three fields out of seven and flagged the total as
not-found, at fifty-eight percent confidence. It said, in effect, *I don't know*. That is
the safest thing any of the three did."

### Act 2 — `understand` (15 credits, 3.9s)

**Visual:** Side by side — document vs. returned values.

| Field | Returned | Document | match | confidence | groundingScore | recognitionScore |
|---|---|---|---|---|---|---|
| `total_amount` | **26.86** | $86.86 | `id_match` | 0.970 | 0.95 | **0.678** |
| `tax_amount` | **5.27** | $5.87 | `id_match` | 0.970 | 0.95 | **0.569** |

**VO:** "The mid mode returned twenty-six eighty-six and five twenty-seven. Both wrong. Both
at ninety-seven percent confidence, ninety-five percent grounding, and an identity match.
Every signal a reasonable integrator would threshold on said auto-approve — on two wrong
numbers."

**VO:** "The reason is structural, not bad luck. Grounding answers *is this value where the
model says it is* — which was true; it read the right box. It cannot answer *were the glyphs
read correctly*, which is what failed. Recognition score is the only signal that measures
that, and it was the only one that dissented."

> **Precision, on camera and off:** recognition score is a **floor, not a detector**. In this
> same response `payer_name` — a *correct* field — scores 0.611, lower than the wrong total at
> 0.678. It does not identify which field is wrong. It refuses to vouch for a page it could
> not read cleanly. Claim that, not more.

### Act 3 — `agentic` (24 credits, 8.5s)

**Visual:** Totals correct — $86.86, $5.87. Then the line-item table:

```
document:  Parcel 1   qty 2   $14.50        returned:  "Parcel"   qty 1
           Parcel 2   qty 1   $39.99                   "Parcel"   qty 2
```

**VO:** "The most expensive mode fixed the totals and broke the line items instead. The
descriptions collapsed and the row numbers shifted into the quantity column. Two wrong
fields either way."

**Visual:** Highlight the absence — search the response for `recognitionScore`, zero hits.

**VO:** "And being VLM-augmented, it emits no recognition score at all. Not one field.
Triple the cost bought better answers and no way to tell whether they were right."

### The gate's verdict (and its cost)

**Visual:** The real threshold table for this document type.

| Signal | Value | `invoice` floor | Verdict |
|---|---|---|---|
| confidence | 0.970 | ≥ 0.85 | ✅ pass |
| groundingScore | 0.95 | ≥ 0.70 | ✅ pass |
| recognitionScore | 0.678 | ≥ 0.80 | ❌ **FAIL** |

**VO:** "The gate refuses to auto-approve. And I want to be honest about what that costs: at
this floor, thirteen of sixteen fields go to a human — including correct ones. In agentic
mode, all sixteen, because there's no score to check. These thresholds are marked
uncalibrated in the code, and a test enforces that they don't claim otherwise. Calibrating
them against real documents is open work. An uncalibrated gate should over-refer."

> **Do not show a flat three-row table as if it were the whole policy.** Routing is a
> nine-step ordered procedure (`extraction-adapter.mjs:400–470`): match label first —
> `fuzzy_match`, `not_found`, `id_match_partial` always refer regardless of score — then
> composite confidence, then the grounding veto, then the recognition veto, then
> absent-recognition policy. Show the table as the *last two steps* of a longer walk.

**VO (land it):** "The signals that tell you an action is safe are not the signals that tell
you it's correct. A gate that confuses the two is decoration."

---

## The redaction beat (1:30–2:00)

*Needs P7.*

**VO:** "Same gate, different irreversible action. Before this goes out for signature, the
PII gets redacted. Staging redactions is reversible and runs unattended. Applying them
destroys content permanently — so it sits behind the same approval queue as the send."

**Visual:** Three files: original, staged, applied. Ctrl-F the staged one for the SSN. **No
match.**

**VO:** "Here's the part that matters. Search the staged file and you find nothing — it looks
clean. It isn't. Nutrient re-compresses the content stream, so the naive check passes on all
three files."

**Visual:** Decompress every `FlateDecode` stream. The staged document still contains it.

| document | bytes | raw hit | after decompression |
|---|---|---|---|
| original | 3806 | yes | — |
| staged | 3653 | no | **yes** |
| applied | 5689 | no | no |

**VO:** "The staged document looks redacted and is not. That gap — between a check that
passes and a document that's still dangerous — is exactly what the gate guards."

---

## The self-audit beat (2:00–2:15)

*Cut this first if over length.*

**VO:** "We audited our own gate and it failed. The approval card was written carefully to
show only the folder name — no payload dump. But the API endpoint behind it still returned
the raw payload: a social security number and the full recipient list, straight past the
redaction the card was doing. Filed upstream as issue eighteen, fixed in core zero-three-oh,
consumed here by version bump. Two other servers on the same core inherit the fix."

---

## Story 2 (2:15–3:15) — crash without double-send

*Needs P1, P3, P4.*

**Visual:** The agent creates a draft folder — reversible — and proposes a send.

**VO:** "Now the irreversible part. The draft folder is reversible; it's just a folder. The
send is not. The plan enters the approval queue."

**Visual:** Browser, approval card: `✍️ Sign: …`, Folder, Folder ID, Recipients, Agent's
reason, and a row labelled **⚠️ Irreversible** — *"Approving sends this document to the
listed recipients for signature. This action cannot be undone. Emails will be sent
immediately."*

**VO:** "A human-readable card with an explicit irrevocability warning. Not a JSON dump. The
human approves."

**Visual:** Plan → `executing`. The gateway call fires. Crash injection fires immediately
after the journal fsyncs.

**VO:** "The plan transitions to executing, the journal is fsync'd, the send call goes out —
and the process dies. Mid-send. The worst possible moment, and we trigger it deterministically
so you can run this yourself."

### Branch A — the send did not happen

**Visual:** Restart. Journal replays. One plan stuck in `executing`. Reconcile against the
gateway: `folderStatus: DRAFT`.

**VO:** "On restart the journal replays and finds a plan stuck in executing. The core asks the
gateway the only question that matters: is this folder still a draft, or was it shared? Draft
— the send never happened. The plan is released for retry, and the audit log contains no
entry claiming a send that didn't occur."

### Branch B — the send did happen

**Visual:** Same crash, `folderStatus: SHARED`.

**VO:** "Run it again and let the send land before the crash. Now the gateway says shared.
The core records executed — and does not send again. That's the half that matters: not
merely *fails safe*, but *exactly once*."

**Visual:** A third state.

**VO:** "And when the gateway can't answer, the core returns unknown and leaves the plan
visibly stuck for a human. It never guesses. Guessing one way double-sends; guessing the
other way puts a lie in the audit log."

---

## Audit, architecture, gaps (3:15–3:40)

*P2 done — the visual is now the **audit** file, not the journal:*
`<journalDir>/esign-audit.jsonl`, produced by `mcp/lib/jsonl-audit-sink.mjs`. It carries the
same statuses as the journal plus `tool`, `reason`, and the chain fields (`prevHash`, `hash`),
and unlike the journal it carries no payload, so it can go on camera. Record it after a
crash-and-recover run so the chain shows the whole story.

**Visual:** The audit file, using the **real** status names.

```jsonl
{"ts":"…","planToken":"pln_7f3a…","status":"previewed","prevHash":"000…","hash":"9f2c…"}
{"ts":"…","planToken":"pln_7f3a…","status":"awaiting_approval","prevHash":"9f2c…","hash":"41ab…"}
{"ts":"…","planToken":"pln_7f3a…","status":"approved","prevHash":"41ab…","hash":"c07d…"}
{"ts":"…","planToken":"pln_7f3a…","status":"executing","prevHash":"c07d…","hash":"1e93…"}
{"ts":"…","planToken":"pln_7f3a…","status":"failed","detail":"EXECUTION_FAILED","prevHash":"1e93…","hash":"5b20…"}
```

> The statuses are fixed by the core: `previewed | awaiting_approval | approved | rejected |
> executing | executed | failed`. There is no `plan_created`, no `reconciled_draft`, and no
> `actor` field. The DRAFT branch journals `failed` with detail `EXECUTION_FAILED`. Invent
> nothing here — it is the one file a judge is most likely to diff.

**VO:** "Append-only, fsync'd, one line per transition. Replaying it reconstructs exactly the
state the system was in when it died."

**Visual:** Architecture — Nutrient DWS → Foxit PDF → Approval gate → Foxit eSign.

**VO:** "Nutrient for extraction with per-field routing and staged redaction. Foxit PDF
Services for reversible document work. Foxit eSign behind a crash-safe gate."

**Visual:** A plain slide, "Known gaps."

**VO:** "Three things we'd want a reviewer to know. The thresholds aren't calibrated. The
approval server checks origin headers but carries no shared secret, so it defends against a
malicious web page and not a hostile local process — that's filed upstream as issue twenty.
And redaction can't be reconciled at all, because the endpoint keeps no server-side state, so
we return unknown rather than guess."

---

## Close (3:40–3:55)

**Visual:** Final card.

```
No Undo
github.com/jpka/no-undo
safe-write-mcp-core on npm
DevNetwork [API + Cloud + AI] Hackathon 2026
```

**VO:** "No Undo. Because some actions can't be undone — and a confirmation prompt that shows
you a confidently wrong number isn't safety, it's theater."

**Fade to black.**

---

## Production notes

- **Screen recording:** OBS, 1080p, terminal + browser side by side.
- **Terminal:** JetBrains Mono or Fira Code, 14pt, dark theme.
- **Browser:** clean profile, no bookmarks bar. Read the approval-server port off stderr each run.
- **Capture terminal output for real** (`asciinema` or `script`) rather than retyping it. Every
  line the previous draft of this script quoted was invented; none of it was emitted by code.
- **Audio:** quiet room, no music under voiceover. Optional bed under the close.
- **Pacing:** let the JSON and the approval card sit 2–3 seconds. The viewer has to read them.
- **The crash shot** is the money shot, and P3 makes it repeatable — record it several times
  and take the cleanest.
- **Before uploading:** confirm `gh repo view jpka/no-undo --json isPrivate` returns `false`.
