# Demo Video Script — No Undo

**Target length:** 3:30–3:50 (rules cap: 2–4 min)
**Format:** Screen recording + voiceover, 1080p
**Tone:** Calm, technical, no hype. Show, don't tell. Volunteer the gaps.

Every beat below is driven by `scripts/demo.mjs`, one command per beat. That is
deliberate: recording a live pipeline by hand is where takes die — a mistyped
flag, a stale journal from the previous attempt, a crash you have to time with
`kill -9`. A retake is now the same keystroke.

```bash
set -a; source .env; set +a
node scripts/demo.mjs check     # preflight, spends nothing
node scripts/demo.mjs reset     # clean journal between takes
node scripts/demo.mjs gate      # Beat 2 — prompt → gate
node scripts/demo.mjs vin       # Beat 3 — the VIN
node scripts/demo.mjs crash     # Beat 4 — crash without double-send
node scripts/demo.mjs audit     # Beat 5 — the audit trail
```

---

## Do not record until

| # | Prerequisite | Status |
|---|---|---|
| P0 | **`jpka/no-undo` is public.** Confirm with `gh repo view jpka/no-undo --json isPrivate` → `false`. | ✅ verified public Sep 2 |
| P1 | Agent loop drives the full lifecycle. | ✅ |
| P2 | Hash-chained, fsync'd JSONL audit sink. | ✅ |
| P3 | Deterministic crash injection (`NO_UNDO_CRASH_AFTER_FSYNC`). | ✅ |
| P4 | A real send, `folderStatus: SHARED` observed. | ✅ five `executed` records; signed PDF downloaded |
| P5 | Real Foxit PDF assembly in draft creation. | ✅ |
| P6 | Nutrient and eSign on one PlanStore. | ✅ |
| P7 | Staged-vs-applied redaction artifact, committed. | ✅ `docs/fixtures/probe-{original,staged,applied}.pdf` |
| P8 | CI runs the full suite. | ✅ 255 tests |
| P9 | Hackathon rules committed. | ✅ `docs/hackathon-rules.md` |

**Do not screen-record a raw journal file** — journal records carry the full
`payload`. The audit trail is safe to show: its events carry no payloads.

**The approval server has no fixed port.** It binds `:0` and prints the port to
stderr. You cannot pre-open a bookmarked tab; read it off the terminal each run.

---

## Cold open (0:00–0:20) — one prompt

**Visual:** Clean terminal, dark theme. One line typed:

```
Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.
```

**VO:** "One prompt. Parsing, assembly, extraction, redaction — all reversible,
all unattended. Exactly one step can't be undone, and that's the one we stop on."

**Title card:**

```
No Undo — an approval gate for the one step an agent can't take back
DevNetwork [API + Cloud + AI] Hackathon 2026
```

---

## Beat 1 (0:20–0:50) — what the document is

**VO:** "The input is a bad scan. Skewed lines, OCR-hostile glyphs, no PO number
anywhere on the page. A freight invoice also carries things the people signing
it have no business seeing — a driver's mobile, their email, the tractor VIN."

**Visual:** The messy PDF, then the shipment-contacts block of the assembled one.

**VO:** "So the job isn't 'read the document.' It's: read it, know which fields
you're unsure about, remove what shouldn't travel, and prove you removed it."

---

## Beat 2 (0:50–1:50) — prompt to gate

```bash
node scripts/demo.mjs gate
```

**Visual:** Let it run. The lines land in order — assembly, extraction, redaction,
verification, draft creation.

**VO over the extraction line:** "Sixteen fields. Two auto-approve. Eleven get
caught by the OCR recognition floor — and the card names them. That floor is the
only signal that measures whether the glyphs were actually read, as opposed to
whether the model feels confident about what it guessed."

**VO over the redaction line:** "Three redaction target sets applied. Then five
values verified absent from the outgoing document, and the signature field
verified intact. Verified, not assumed. That distinction is the next beat."

**Visual:** Open the approval URL. Let the card sit on screen 3–4 seconds.

**VO:** "This is everything a human needs to decide, on one screen. What was
asked. Who it goes to. What was removed and the proof it's gone. The document's
hash. And the fact that the thresholds behind that routing are uncalibrated —
because they are, and a gate that hides its own uncertainty is decoration."

**Do not click approve yet.**

---

## Beat 3 (1:50–2:25) — the VIN

```bash
node scripts/demo.mjs vin
```

**Visual:** The two-row table renders live.

```
Target                         HTTP   Bytes    VIN after apply
preset: "vin"                  200    66178    still present
regex: "[A-HJ-NPR-Z0-9]{17}"   200    68489    removed
```

**VO:** "Same document, same API, two ways to ask for the same redaction. Both
return two hundred. Both return a PDF that opens. One of them didn't remove
anything. The only difference a caller can see is a byte count — and nobody
thresholds on a byte count."

**VO:** "We'd pinned that preset in a list called CONFIRMED_PRESETS, because it
returned two hundred when we probed it. It does. It just doesn't match. Confirming
an API accepts an identifier is a different question from confirming it does
anything, and the name was carrying more weight than the probe behind it."

**VO:** "Which is why the pipeline reads the document back and checks. A redaction
we can't prove doesn't become a send — it fails the run before a draft exists."

*If over length, this is the second thing to cut, after Beat 5.*

---

## Beat 4 (2:25–3:15) — crash without double-send

```bash
node scripts/demo.mjs crash
```

**VO:** "The dangerous window isn't before the irreversible call. It straddles it.
Between the moment you commit to sending and the moment you learn whether it
landed, a crash leaves you unable to tell the difference."

**Visual:** Run 1. The crash fires between the journal fsync and the gateway call.
Process gone.

**VO:** "Journalled as executing, and fsync'd before the call — not after. So the
plan is stuck in a state we can query, not one we've forgotten."

**Visual:** Run 2, same command, no crash flag. The recovery lines print.

**VO:** "On restart it replays the journal and asks the system of record the only
question that matters: is this folder DRAFT or SHARED. DRAFT means the send never
happened, so it's safe to retry. SHARED means it did, so record it and never send
again. Either way the document goes out exactly once."

**Visual:** The result JSON — `status: executed`, the reconcile line naming the
observed `folderStatus`.

**VO:** "Nobody else in this hackathon is going to demo a crash. This is the part
most designs don't model at all."

---

## Beat 5 (3:15–3:30) — the audit trail

```bash
node scripts/demo.mjs audit
```

**Visual:** The records, then `intact`, then the tampered copy → `BROKEN at
record N — hash mismatch`.

**VO:** "Every decision is appended to a hash-chained log, fsync'd. Edit one
record and every record after it stops verifying. The log can't be quietly
revised after the fact."

*Cut this first if over length.*

---

## Close (3:30–3:50)

**VO:** "Signing stays outside the MCP catalog on purpose. Foxit's forty tools are
reversible by design; moving the send in there would collapse the boundary this
whole thing exists to defend. Nutrient does the document work — the confidence
routing that decides what a human looks at, the redaction, and the read-back that
proves the redaction happened."

**VO:** "The gaps are in the README. Thresholds aren't calibrated. The redaction
targets are a fixed list, not a detector. The approval server has no shared
secret yet. We'd rather tell you than have you find out."

**Final card:**

```
No Undo
github.com/jpka/no-undo
255 tests · Foxit PDF Services + eSign · Nutrient DWS
```

---

## Production notes

- **Screen recording:** OBS, 1080p, terminal + browser side by side.
- **Terminal:** JetBrains Mono, dark theme (`scripts/record-demo.sh` uses 110×36,
  20px, dracula). The extraction line wraps at any width that still fits 1080p —
  it runs past 450 characters — so it wraps to five lines and that is expected.
  It prints twice, once as `[pipeline]` and once as `[agent]`; don't linger.
- **Browser:** clean profile, no bookmarks bar. Read the approval port off stderr.
- **`node scripts/demo.mjs reset` between takes.** A leftover `executing` plan
  makes the loop refuse to start new work — correct behaviour, wrong moment.
- **Capture terminal output for real.** `scripts/record-demo.sh` does it —
  asciinema over the real pty, rendered to 1080p h264. See "Recording" below.
- **Audio:** quiet room, no music under voiceover.
- **Pacing:** let the approval card and the VIN table sit 3–4 seconds each. The
  viewer has to actually read them.
- **Beat 4 is the money shot** and P3 makes it repeatable — record it several
  times, take the cleanest.
- **`crash` and `gate` create real DRAFT folders** in Foxit eSign. Clear them
  from the eSign UI after recording.
- **`crash` sends for real** (`--auto-approve`). Point `DEMO_RECIPIENT` at an
  address you own before recording it:
  `DEMO_RECIPIENT="Your Name <you@yourdomain.com>" node scripts/demo.mjs crash`
- **Before uploading:** confirm `gh repo view jpka/no-undo --json isPrivate`
  returns `false`.

---

## Recording

The terminal beats are captured, not reconstructed:

```bash
set -a; source .env; set +a
node scripts/demo.mjs reset          # clean chain before a full take
scripts/record-demo.sh               # gate, vin, crash, audit
.demo/tools/venv/bin/python scripts/make-cards.py   # title, beat1, close
python3 scripts/demo-subtitles.py    # per-beat + combined SRT
```

`record-demo.sh` installs its own tools into `.demo/tools` (asciinema, agg,
JetBrains Mono) and writes `.demo/recordings/{beat}.{cast,gif,mp4}` at 1080p30,
plus `reel.mp4` — the four beats stitched in order. Output lands in `.demo/`,
which is gitignored — journals carry payloads.

Subtitles stay in sidecar `.srt` files and are never burned in, so a VO line can
be re-cut without re-rendering video.

Two things the beat list doesn't make obvious:

- **`demo.mjs reset` must precede a full take, and `audit` must be recorded
  last.** `audit` reads the chain `gate` and `crash` write, and `reset` deletes
  that chain — recorded on its own after a reset it prints one record, or none.
  The `gate` beat cuts its recording when a *new* `awaiting_approval` lands, so
  it is correct on a dirty chain too, but the beat order still matters.
- **A beat's voiceover routinely outlasts its output.** `vin` prints its table
  in two seconds and then gets narrated for half a minute. `record-demo.sh`
  holds the final frame per beat (`hold_for`) so the VO doesn't run off the
  end; `demo-subtitles.py` anchors each cue to the frame where its subject
  appears and reports where the narration ends. If you rewrite a VO line,
  re-run both.

Segments that aren't terminal output get subtitles too — `cold-open.srt`,
`beat1.srt` (the document), `gate-browser.srt` (the approval card) and
`close.srt`. These are generated against a zero start, so offset them to
wherever they land in the edit.

`make-cards.py` renders three of those four as video: `title.mp4` (11s),
`beat1.mp4` (31s) and `close.mp4` (41s), styled to match the terminal takes so
the cut doesn't jump. Beat 1 cuts from the messy source to the assembled
shipment-contacts block, then to the redacted one exactly on "prove you removed
it" — the assembled and redacted frames are the committed probe artifacts, the
same bytes the README's evidence table is drawn from.

**Only the approval card has to be captured by hand.** It's a live page on an
ephemeral port: run `node scripts/demo.mjs gate`, read the port off stderr,
open it, and record 3–4 seconds of the card.

### Length

Measured, at 156 words per minute:

| Segment | Footage | Voiceover |
|---|---|---|
| Cold open + Beat 1 | shot separately | 0:40 |
| Beat 2 — gate | 0:54 | 0:52 |
| Beat 2b — approval card | shot separately | 0:23 |
| Beat 3 — vin | 0:57 | 0:56 |
| Beat 4 — crash | 1:16 | 1:15 |
| Beat 5 — audit | 0:13 | 0:12 |
| Close | shot separately | 0:39 |
| **Terminal reel** | **3:21** | |
| **Everything, assembled** | **5:03** | |

Each beat's footage outlasts its own narration, so nothing runs off the end.
But the whole thing — the 3:21 reel plus the separately-shot cold open, Beat 1,
approval card and close — comes to **5:03, over the rules cap of 4:00**. The
cut order in the beats above still applies: drop Beat 5 first (−0:13), then
Beat 3 (−0:57), landing at **3:52**. That clears the cap by eight seconds, so
the close card can't run long. Re-run `demo-subtitles.py` after any VO edit; it
reports where each beat's narration ends, and `record-demo.sh`'s `hold_for` is
sized to those numbers.
