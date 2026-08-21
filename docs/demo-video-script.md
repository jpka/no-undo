# Demo Video Script — No Undo

**Target length:** 2:30–3:30  
**Format:** Screen recording + voiceover, 1080p  
**Stories:** (1) The gate catches a lie, (2) Crash without double-send  
**Tone:** Calm, technical, no hype. Show, don't tell.

---

## Opening (0:00–0:20)

**Visual:** Terminal, clean dark theme. Title card fades in:

```
No Undo — an agent approval gate for irreversible actions
DevNetwork Hackathon 2026
```

**VO:** "Most agent confirmation prompts are decoration. They show you what the agent *thinks* it's doing, and you click yes. This is what happens when the agent is confidently wrong — and what happens when the process dies at the worst possible moment."

---

## Story 1: The Gate Catches a Lie (0:20–1:30)

**Visual:** Show a photo/scan of a messy paper invoice. Highlight "Total due $86.86" in red.

**VO:** "This is a freight invoice. Total due: eighty-six dollars and eighty-six cents. We send it to Nutrient's document extraction API in understand mode — their highest-accuracy structured extraction."

**Visual:** Split screen. Left: the invoice. Right: JSON output from Nutrient showing:
```json
{
  "total_amount": 26.86,
  "match": "id_match",
  "confidence": 0.970,
  "groundingScore": 0.95,
  "recognitionScore": 0.678
}
```

**VO:** "Nutrient returns twenty-six dollars and eighty-six cents. Ninety-seven percent confidence. Ninety-five percent grounding. The two signals a reasonable integrator would threshold on said auto-approve."

**Visual:** Highlight the `recognitionScore: 0.678` in amber. Show a threshold table:

| Signal | Value | Threshold | Verdict |
|--------|-------|-----------|---------|
| confidence | 0.970 | ≥ 0.90 | ✅ pass |
| groundingScore | 0.95 | ≥ 0.90 | ✅ pass |
| recognitionScore | 0.678 | ≥ 0.80 | ❌ **FAIL** |

**VO:** "Recognition score is the only signal that measures whether the glyphs were read correctly, not whether the value came from the right region of the page. It's the only one that dissented. The gate refuses to auto-approve."

**Visual:** Show the approval UI rendering the plan with a red banner: "⚠️ 1 field below threshold — human review required." The human clicks "Reject," corrects the total to $86.86.

**VO:** "A human reviews, corrects the total, and only then does the document proceed. The gate didn't trust the API's confidence. It trusted the signal that actually measures reading accuracy."

**Visual:** Brief cut to agentic mode output — totals correct, but line items mangled ("Parcel 1" → description "Parcel", quantity 1).

**VO:** "Agentic mode — double the cost, VLM-augmented — got the totals right and silently broke the line items instead. And it emits no recognition score at all. Paying more bought better answers and less ability to tell whether they were right."

---

## Story 2: Crash Without Double-Send (1:30–2:40)

**Visual:** Terminal. Agent loop running. Show the pipeline:

```
[agent] Creating draft folder...
[agent] Draft created: folderId=abc123, planToken=pln_7f3a...
[agent] Plan awaiting approval.
```

**VO:** "Now the irreversible part. The agent creates a draft folder — reversible, just a folder in the eSign system. Then it proposes a send. The plan enters the approval queue."

**Visual:** Browser showing the localhost approval UI. Card renders:
- ✍️ Sign: ACME Freight Invoice
- Recipients: Alice Smith, Bob Jones
- ⚠️ Irreversible warning

**VO:** "The approval UI shows the document name, the recipients, and an explicit irrevocability warning. Not a JSON dump — a human-readable card. The human clicks Approve."

**Visual:** Click Approve. Terminal shows:

```
[agent] Plan approved. Transitioning to executing...
[agent] Calling gateway send-draft endpoint...
```

**VO:** "The plan transitions to 'executing.' The agent calls the gateway to send the draft. And right now —"

**Visual:** Terminal freezes. `kill -9` executed. Screen goes red: "PROCESS KILLED."

**VO:** "— the process dies. Mid-send. The worst possible moment."

**Visual:** Terminal restarts. Agent loop runs again.

**VO:** "On restart, the journal replays. There's a plan stuck in 'executing' — the process died before it could confirm. The core queries the gateway: is this folder SHARED or still DRAFT?"

**Visual:** Terminal shows:

```
[agent] Reconciling stuck plan pln_7f3a...
[agent] Gateway folderStatus: DRAFT → send did not happen
[agent] Plan released for retry. No double-send.
[agent] Audit log: HONEST — no false "executed" entry
```

**VO:** "The gateway says DRAFT — the send never happened. The plan is released for retry. The audit log is honest: there is no false 'executed' entry claiming a send that didn't happen."

**Visual:** Show the audit log JSONL:

```jsonl
{"ts":"...","token":"pln_7f3a","event":"plan_created","prevHash":"0000..."}
{"ts":"...","token":"pln_7f3a","event":"approved","actor":"jpka","prevHash":"a1b2..."}
{"ts":"...","token":"pln_7f3a","event":"executing","prevHash":"c3d4..."}
{"ts":"...","token":"pln_7f3a","event":"reconciled_draft","prevHash":"e5f6..."}
```

**VO:** "Hash-chained, append-only. Every transition recorded. No silent under-execution. No lying audit trail. This is the demo."

---

## Closing (2:40–3:00)

**Visual:** Architecture diagram — four boxes in pipeline order: Nutrient DWS (extraction + recognition floor), Foxit PDF (reversible document work), Approval (crash-safe two-step send), Foxit eSign (irreversible send). Arrows between each.

**VO:** "Three vendors, one gate. Nutrient for extraction with per-field confidence routing. Foxit PDF Services for reversible document work. Foxit eSign behind a crash-safe approval gate. The gate doesn't trust the API's confidence — it trusts the signal that measures what actually matters. And if the process dies at the worst possible moment, it recovers without lying and without double-sending."

**Visual:** Final card:

```
No Undo
github.com/jpka/no-undo
DevNetwork Hackathon 2026
```

**VO:** "No Undo. Because some actions can't be undone — and a confirmation prompt that shows you the wrong number isn't safety, it's theater."

**Fade to black.**

---

## Production notes

- **Screen recording:** OBS, 1080p, capture terminal + browser side by side
- **Terminal font:** JetBrains Mono or Fira Code, 14pt, dark theme
- **Browser:** Clean profile, no bookmarks bar, localhost approval UI
- **Audio:** Quiet room, no music during voiceover. Optional subtle bed under closing.
- **Pacing:** Let the JSON and the approval UI sit for 2–3 seconds each. The viewer needs to read them.
- **Crash shot:** The `kill -9` is the money shot. Practice the timing — the terminal should freeze mid-line.
- **Total runtime target:** ~3:00. Tight enough to hold attention, long enough to tell both stories.
