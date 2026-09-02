# Devpost submission copy

Paste-ready text for the four things the rules ask for: name + pitch, public
repo with setup, the 2–4 min video, and one line per sponsor on where their API
did the real work.

---

## Project name

**No Undo**

## One-line pitch

An approval gate for the one step an agent can't take back — one prompt in,
signed document out, with the irreversible send held for a human and made
crash-safe.

## Public repo

https://github.com/jpka/no-undo — setup in the README (`Reproduce it`). Two
paths: Foxit-only on a single credential pair, or the full pipeline with
Nutrient DWS. `npm test` runs 255 tests with no live API calls.

Live walkthrough: https://jpka.github.io/no-undo/

## Demo video

*(link once uploaded — 2–4 min, end to end)*

---

## Where the sponsor's API did the real work

**Foxit** — the PDF Services MCP server assembles the outgoing document
(`pdf_from_html`) from ~40 reversible tools, and the eSign API, deliberately
called directly rather than through that catalog, performs the one action that
cannot be undone. The boundary between those two is the project.

**Nutrient DWS** — `/extraction/extract` supplies the per-field confidence
signals that decide what a human must look at, `/build` applies the PII
redactions, and `/extraction/parse` reads the redacted document back to prove
the values are gone — because a redaction call returns HTTP 200 whether or not
it removed anything.

---

## Foxit challenge — *Your Agent Shouldn't Sign That*

The challenge leaves signing out of the MCP catalog and asks how we'd design
the handoff. We agree with the boundary and defended it: the 40-tool catalog is
reversible by design, and moving signing into it would collapse the safety
property the catalog has. So the agent crosses a boundary to sign.

What's on our side of it:

- Everything before the send — prompt parsing, Foxit PDF assembly, extraction,
  redaction, verification — runs unattended, because all of it is reversible.
- The send stops at an approval card showing what was asked, who it goes to,
  what was removed and the proof it's gone, the document's SHA-256, and the
  fact that the routing thresholds are uncalibrated.
- The send is crash-safe. `beginExecute()` journals `executing` and fsyncs
  *before* the gateway call, so a process that dies mid-send leaves a plan in a
  queryable state. On restart, recovery asks the system of record whether the
  folder is DRAFT or SHARED and either retries or records — exactly once. The
  demo shows this happening for real.

## Nutrient DWS challenge — *Turn Documents Into Something People Actually Trust*

Three core operations, and the third exists because the first two lie in
opposite directions:

- **Extraction with confidence routing.** On the first live call, `understand`
  mode returned `total_amount: 26.86` where the document reads `$86.86` — at
  `id_match`, confidence `0.970`, grounding `0.95`. Every signal a reasonable
  integrator thresholds on said auto-approve. Only `recognitionScore` (0.678)
  dissented, because it is the only signal measuring whether the glyphs were
  read. The router treats it as a veto.
- **Redaction.** `/build` applies the PII targets.
- **Verification.** `/extraction/parse` reads the redacted document back and
  confirms each value is gone. This is not belt-and-braces: `preset: "vin"`
  returns HTTP 200 and a valid PDF and *does not redact*. The only difference a
  caller can see is a byte count. A redaction that can't be proven fails the
  run before a draft exists.

Deterministic and auditable: every decision is appended to a hash-chained,
fsync'd JSONL trail. Editing one record invalidates every record after it.

## Overall

- **Progress** — two MCP servers, a published npm core (`safe-write-mcp-core`),
  255 tests, CI green, a live end-to-end run against both sponsors' APIs.
- **Concept** — agents are being handed write access to systems where actions
  can't be undone, and the industry's answer is a confirmation prompt. A
  confirmation prompt doesn't survive a crash, and it doesn't tell you whether
  the thing you're approving is correct.
- **Feasibility** — the reusable part is already shipped and published: the
  approval gate, the durable plan store, and the exactly-once execution ledger
  are domain-agnostic. eSign is the first irreversible action wired to it.

---

## Known gaps we volunteer

Thresholds are uncalibrated. Redaction targets are a fixed list, not a
detector. The approval server has no shared secret yet. The Nutrient trial
watermarks the outgoing document. All four are in the README, because a gate
that hides its own uncertainty is decoration.
