#!/usr/bin/env python3
"""Generate SRT subtitles for the demo reel, anchored to what is on screen.

agg caps every inter-event gap at --idle-time-limit, so the rendered GIF
timeline is not the cast timeline. We replay the cast applying the same cap
to recover the rendered timestamp of each line, then pin each VO cue to the
frame where its subject appears.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REC = os.path.join(ROOT, ".demo/recordings")
WPS = 2.6          # calm technical narration, words per second
MIN_CUE = 2.2
MAX_LINE = 46      # characters per subtitle line

def timeline(cast):
    """[(rendered_time, text)] for each output event.

    agg caps every inter-event gap at --idle-time-limit, so a cue anchored to
    the raw cast time fires early by however much dead time was squeezed out.
    record-demo.sh records the cap it rendered with next to the cast; mirroring
    it here instead would drift the moment the pacing is retuned.
    """
    side = cast.replace(".cast", ".render.json")
    cap = json.load(open(side))["idle"] if os.path.exists(side) else 5.0
    lines = open(cast, encoding="utf-8").read().splitlines()
    out, prev, acc = [], 0.0, 0.0
    for l in lines[1:]:
        t, typ, data = json.loads(l)
        acc += min(t - prev, cap)
        prev = t
        if typ == "o":
            out.append((acc, data))
    return out

def anchor(tl, needle, default=0.0):
    for t, data in tl:
        if needle in data:
            return t
    return default

def dur(text):
    return max(MIN_CUE, len(text.split()) / WPS)

def srt(cues, path, offset=0.0):
    """cues: [(earliest_start, text)] laid out in order.

    An anchor is the earliest a cue may appear, not a fixed start. Treating it
    as fixed lets a long cue collide with the next anchor, and clamping the
    overlap away produced 0.8s flashes nobody can read — and, where two anchors
    were close together, cues out of narration order. So each cue starts at the
    later of its anchor and the end of the one before it, and keeps its full
    reading time. Beats hold their final frame (record-demo.sh `hold_for`) to
    absorb the drift.
    """
    GAP = 0.15
    body, cursor = [], 0.0
    for start, text in cues:
        start = max(start, cursor)
        end = start + dur(text)
        body.append((start + offset, end + offset, text))
        cursor = end + GAP
    def ts(s):
        h, s = divmod(s, 3600); m, s = divmod(s, 60)
        return f"{int(h):02d}:{int(m):02d}:{s:06.3f}".replace(".", ",")
    with open(path, "w", encoding="utf-8") as f:
        for i, (a, b, text) in enumerate(body, 1):
            f.write(f"{i}\n{ts(a)} --> {ts(b)}\n{text}\n\n")
    return body[-1][1] if body else 0.0


def wrap(s):
    """Break one VO line into subtitle-sized cues of at most two lines each.

    An earlier version folded any overflow back into two long lines; at ~87
    characters those re-wrap to four lines in whatever editor opens them, at a
    line length nobody can read on a video. Overflow becomes another cue
    instead — the sequential layout below spaces them out.
    """
    lines, cur = [], ""
    for w in s.split():
        if cur and len(cur) + 1 + len(w) > MAX_LINE:
            lines.append(cur); cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return ["\n".join(lines[i:i + 2]) for i in range(0, len(lines), 2)]


BEATS = {}

# --- Cold open and Beat 1: no terminal output, shot separately -------------
# Generated against a zero start; offset them to wherever they land in the cut.
BEATS["cold-open"] = [
    (0.5, "One prompt. Parsing, assembly, extraction, redaction — all reversible, all unattended."),
    (5.0, "Exactly one step can't be undone, and that's the one we stop on."),
]

BEATS["beat1"] = [
    (0.5, "The input is a bad scan. Skewed lines, OCR-hostile glyphs, no PO number anywhere on the page."),
    (6.0, "A freight invoice also carries things the people signing it have no business seeing — a driver's mobile, their email, the tractor VIN."),
    (13.0, "So the job isn't 'read the document.' It's: read it, know which fields you're unsure about,"),
    (18.0, "remove what shouldn't travel, and prove you removed it."),
]

# --- Beat 2: gate ---
tl = timeline(f"{REC}/gate.cast")
a_extract = anchor(tl, "Nutrient extraction:")
a_redact  = anchor(tl, "3 target set(s) applied")
a_gate    = anchor(tl, "Awaiting human approval")
BEATS["gate"] = [
    (max(6.0, a_extract - 1.0), "Sixteen fields. Two auto-approve. Eleven get caught by the OCR recognition floor — and the card names them."),
    (a_extract + 6.5, "That floor is the only signal that measures whether the glyphs were actually read, as opposed to whether the model feels confident about what it guessed."),
    (a_redact, "Three redaction target sets applied. Then five values verified absent from the outgoing document, and the signature field verified intact."),
    (a_redact + 8.0, "Verified, not assumed. That distinction is the next beat."),
    (a_gate, "Exactly one step can't be undone, and that's the one we stop on."),
]

# --- Beat 2b: the approval card in the browser (shot separately) ---
BEATS["gate-browser"] = [
    (0.5, "This is everything a human needs to decide, on one screen."),
    (4.0, "What was asked. Who it goes to. What was removed and the proof it's gone. The document's hash."),
    (10.0, "And the fact that the thresholds behind that routing are uncalibrated — because they are,"),
    (15.0, "and a gate that hides its own uncertainty is decoration."),
]

# --- Beat 3: vin ---
tl = timeline(f"{REC}/vin.cast")
a_table = anchor(tl, "VIN after apply")
a_rows  = anchor(tl, "still present")
BEATS["vin"] = [
    (0.5, "Same document, same API, two ways to ask for the same redaction."),
    (max(a_rows, a_table + 1.0), "Both return two hundred. Both return a PDF that opens. One of them didn't remove anything."),
    (a_rows + 5.0, "The only difference a caller can see is a byte count — and nobody thresholds on a byte count."),
    (a_rows + 10.5, "We'd pinned that preset in a list called CONFIRMED_PRESETS, because it returned two hundred when we probed it. It does. It just doesn't match."),
    (a_rows + 17.0, "Confirming an API accepts an identifier is a different question from confirming it does anything."),
    (a_rows + 22.0, "Which is why the pipeline reads the document back and checks. A redaction we can't prove doesn't become a send."),
]

# --- Beat 4: crash ---
tl = timeline(f"{REC}/crash.cast")
a_crash   = anchor(tl, "crash-injection")
a_recover = anchor(tl, "Recovered 1 stuck-executing")
a_exec    = anchor(tl, "Send succeeded")
BEATS["crash"] = [
    (0.5, "The dangerous window isn't before the irreversible call. It straddles it."),
    (5.0, "Between the moment you commit to sending and the moment you learn whether it landed, a crash leaves you unable to tell the difference."),
    (a_crash, "Journalled as executing, and fsync'd before the call — not after."),
    (a_crash + 4.0, "So the plan is stuck in a state we can query, not one we've forgotten."),
    (a_recover, "On restart it replays the journal and asks the system of record the only question that matters: is this folder DRAFT or SHARED."),
    (a_recover + 8.0, "DRAFT means the send never happened, so it's safe to retry. SHARED means it did, so record it and never send again."),
    (a_exec, "Either way the document goes out exactly once."),
    (a_exec + 3.5, "Nobody else in this hackathon is going to demo a crash. This is the part most designs don't model at all."),
]

# --- Beat 5: audit ---
tl = timeline(f"{REC}/audit.cast")
a_intact = anchor(tl, "verifyAuditChain")
BEATS["audit"] = [
    (0.5, "Every decision is appended to a hash-chained log, fsync'd."),
    (4.5, "Edit one record and every record after it stops verifying."),
    (8.0, "The log can't be quietly revised after the fact."),
]

# --- Close card (shot separately) ---
BEATS["close"] = [
    (0.5, "Signing stays outside the MCP catalog on purpose. Foxit's forty tools are reversible by design;"),
    (5.5, "moving the send in there would collapse the boundary this whole thing exists to defend."),
    (10.5, "Nutrient does the document work — the confidence routing that decides what a human looks at, the redaction, and the read-back that proves the redaction happened."),
    (18.0, "The gaps are in the README. Thresholds aren't calibrated. The redaction targets are a fixed list, not a detector."),
    (24.0, "The approval server has no shared secret yet. We'd rather tell you than have you find out."),
]

DURS = {}
for name, cues in BEATS.items():
    out = f"{REC}/{name}.srt"
    expanded = [(t, part) for t, x in cues for part in wrap(x)]
    end = srt(expanded, out)
    DURS[name] = end
    print(f"{name:14s} last cue ends {end:6.1f}s -> {os.path.basename(out)}")


# --- reel: concatenate the beat SRTs onto the combined-video timeline --------

import subprocess

ORDER = ["gate", "vin", "crash", "audit"]

def vdur(p):
    return float(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=duration", "-of", "csv=p=0", p],
        capture_output=True, text=True).stdout.strip())

def parse_srt(p):
    out = []
    for b in re.split(r"\n\s*\n", open(p, encoding="utf-8").read().strip()):
        L = b.splitlines()
        if len(L) < 3:
            continue
        a, e = L[1].split(" --> ")
        out.append((tc(a), tc(e), "\n".join(L[2:])))
    return out

def tc(s):
    h, m, rest = s.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + float(rest.replace(",", "."))

def fmt(s):
    h, s = divmod(s, 3600); m, s = divmod(s, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}".replace(".", ",")

missing = [b for b in ORDER if not os.path.exists(f"{REC}/{b}.mp4")]
if missing:
    print(f"\nno reel.srt — missing video for: {', '.join(missing)}"
          f"\nrun scripts/record-demo.sh first")
    raise SystemExit(0)

cues, off = [], 0.0
for b in ORDER:
    for a, e, t in parse_srt(f"{REC}/{b}.srt"):
        cues.append((a + off, e + off, t))
    off += vdur(f"{REC}/{b}.mp4")
    print(f"  reel: {b:6s} ends {off:7.2f}s")

with open(f"{REC}/reel.srt", "w", encoding="utf-8") as f:
    for i, (a, e, t) in enumerate(cues, 1):
        f.write(f"{i}\n{fmt(a)} --> {fmt(e)}\n{t}\n\n")
print(f"{len(cues)} cues -> reel.srt  ({off:.1f}s of footage)")
