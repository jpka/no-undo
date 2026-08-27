# Foxit trial-engagement contact — Aug 27: use case sent, response processed

Build-plan stage: not a scheduled stage. Not the hackathon sponsor program —
this started as routine trial-engagement outreach from Foxit (a check-in
triggered by an active API trial signup, offering to point us at the right
starting point). The reply came from Jason Welch, Senior Strategic Alliance
Manager at Foxit. We used the opening to send our actual use case and three
technical questions; he answered all three, and the responses were used to
correct the plan.

---

## 1. What happened

Foxit's initial email was a generic trial check-in: "I saw your Foxit API
trial is active... are you testing a specific workflow right now... if you
send me a quick note on what you're trying to build, I can direct you to the
right starting point." A second email followed on production thinking ("how
should the pieces fit together... security, compliance, long-term
maintainability"), offering a tailored product tour.

We replied with the plain-prompt-to-signed-document use case and three
technical questions. Jason answered all three. Summary below, verbatim
corrections in §2, plan consequences in §3.

---

## 2. The response, and what it changes

**Q1 — keep signing outside the MCP catalog?**
Confirmed, in his own words: "Based on the current Foxit tool surface, I
would keep signing outside the MCP catalog for this submission. The current
Foxit MCP server exposes PDF Services operations, while eSign is a separate
API. Your explicit approval gate before the irreversible send is therefore a
sensible pattern to defend."

Consequence: the graded artifact (agent→human handoff design) is validated by
a Foxit engineer. This is quotable material for the Devpost defense
paragraph — with Jason's permission, one line attributing the pattern choice
to his guidance. (Not an official sponsor-program endorsement — a technical
opinion from a Foxit contact, given in a trial-support context.)

**Q2 — how do we get the signed PDF out?** (unblocks pipeline step 6 / cut-list #1)

- `SHARED` means "sent," not "completed." The plan must not call SHARED a
  completed signature anywhere (audit log, demo script, README).
- Signed state is signaled by the `folder_executed` eSign webhook: fires after
  all required signing is complete and digital signatures have been applied.
- Completed envelope download: `GET /esign/api/v1/folders/download?folderId=...`
- Single-document download: `GET /esign/api/v1/folders/document/download?folderId=...&docNumber=...`
- `GET /esign/api/v1/folders/myfolder?folderId=...` stays the polling and
  restart-reconciliation fallback.

The adapter already has the webhook seam: `handleWebhookEvent` at
`mcp/foxit/esign-adapter.mjs:650` dedups on `(folderId, eventName)` via a
durable `.webhook-dedup.json` (`webhookKey` ~line 225). `folder_executed`
routes straight through it, so the send-once guarantee extends to
signed-file retrieval without new machinery.

**Q3 — which PDF generation tool?** (corrects the plan's `pdf_generation` assumption)

- The current MCP catalog does NOT list a `pdf_generation` tool.
- Render the structured invoice data as HTML, then use `pdf_from_html`.
- `pdf_merge` only when combining PDFs you already have.
- For template-driven generation directly from structured JSON, use the Foxit
  Document Generation REST API with a Word template + JSON data. It uses the
  same developer Client ID and Client Secret, so no additional vendor key.

Verified against the installed server (`mcp/foxit/node_modules/.../dist/main.js`):
the catalog has `pdf_from_html`, `pdf_from_url`, `pdf_from_word`, `pdf_merge`,
and 30+ other tools. No `pdf_generation`. The plan's three references to it
were wrong and are corrected in `build-plan.md`.

---

## 3. Plan consequences

1. **`pdf_generation` removed from the plan** (`build-plan.md:32`, `:137`,
   `:177` → `pdf_from_html`). Item B's target is now: render invoice data as
   HTML → `pdf_from_html` → `get_task_result` → base64 → `createfolder`.
   Single-credential repro holds (same Client ID/Secret as eSign).
2. **Item C is de-speculated, not de-gated.** The download route is now named
   by the vendor (`document/download?folderId=...&docNumber=...`), and the
   signed-state signal is `folder_executed`. The live probe (`--probe-download`)
   still has to confirm the route answers for our account and that self-sign
   with two owned inboxes completes inside the poll window — but the guesswork
   about *which* endpoint is gone. Cut-list #1 stays in force only until the
   probe passes.
3. **`SHARED` semantics locked:** audit sink, approval card, and
   `docs/demo-video-script.md` must say "sent for signature" at SHARED and only
   claim a signed document after `folder_executed` + successful download.
4. **Follow-up open item:** the `folder_executed` webhook needs a public HTTPS
   endpoint, which is awkward for a local hackathon demo. Asked Jason whether
   polling `document/download` can be the primary path locally with the
   webhook optional, or whether the webhook should be stood up anyway. Answer
   pending; polling `myfolder`/`document/download` remains the fallback either
   way.

---

## 4. What the contact buys the submission

- A Foxit engineer's validation, in writing before the deadline, of the exact
  pattern the Foxit rubric grades.
- A named download route and signed-state webhook, removing the largest
  remaining probe risk from the cut list.
- A correction that would otherwise have shipped as a broken tool call in the
  demo (calling `pdf_generation` against a catalog that has no such tool).

Status: no code changed by this contact yet. `build-plan.md` reflects the
corrections; the probe and adapter work land in the Aug 29–30 batch.