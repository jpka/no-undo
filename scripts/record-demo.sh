#!/usr/bin/env bash
# Capture the demo beats as real terminal recordings, then render 1080p video.
#
# Same reasoning as scripts/demo.mjs: a retake should be one keystroke, not a
# reconstruction. This captures the actual pty — no retyping, no faked output.
#
#   scripts/record-demo.sh gate vin crash audit    # or omit args for all four
#
# Requires asciinema (capture) and agg (cast -> gif); both are installed into
# .demo/tools on first run. ffmpeg renders the gif to h264.
#
# `crash` SENDS FOR REAL. Point DEMO_RECIPIENT at an address you own.
# Beat order matters: `audit` reads the chain that gate/crash write, so record
# it last. `demo.mjs reset` deletes that chain.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/.demo/tools"
OUT="$ROOT/.demo/recordings"
COLS=110
ROWS=36
mkdir -p "$TOOLS" "$OUT"

ASCIINEMA="$TOOLS/venv/bin/asciinema"
AGG="$TOOLS/agg"
FONTS="$TOOLS/fonts"

if [ ! -x "$ASCIINEMA" ]; then
  echo "installing asciinema into $TOOLS/venv ..."
  python3 -m venv "$TOOLS/venv"
  "$TOOLS/venv/bin/pip" install --quiet asciinema
fi
if [ ! -x "$AGG" ]; then
  echo "downloading agg ..."
  curl -sSL -o "$AGG" \
    "https://github.com/asciinema/agg/releases/latest/download/agg-x86_64-unknown-linux-gnu"
  chmod +x "$AGG"
fi
if [ ! -f "$FONTS/JetBrainsMono-Regular.ttf" ]; then
  echo "downloading JetBrains Mono ..."
  mkdir -p "$FONTS"
  curl -sSL -o "$FONTS/jbm.zip" \
    "https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip"
  unzip -o -j -q "$FONTS/jbm.zip" 'fonts/ttf/JetBrainsMono-*.ttf' -d "$FONTS"
fi

# Per-beat hold on the final frame. The voiceover for a beat routinely outlasts
# its output — `vin` prints a table in two seconds and then gets narrated for
# half a minute — so the last frame has to stay up or the VO runs off the end.
# These are sized to the cue times demo-subtitles.py reports; change a VO line
# and you may need to change these with it.
hold_for() {
  case "$1" in
    gate)  echo 28.3 ;;
    vin)   echo 40.4 ;;
    crash) echo 29.1 ;;
    audit) echo 13.4 ;;
  esac
}

# How much real dead time to keep. agg caps every gap at this. Uncapped, the
# gate beat shows 30 seconds of nothing while the pipeline works and then
# carries its whole voiceover over the last 7 seconds; capped hard, the API
# latency disappears entirely. 10s keeps the waits visible without stalling.
idle_for() { echo 10; }

# Write the per-beat command to a real file and hand asciinema the path.
# Inlining it via `--command "bash -c \"$cmd\""` looks tighter but the beat
# bodies contain their own double quotes, so the outer quoting terminates early.
WRAPPER=""
cleanup() { [ -n "$WRAPPER" ] && rm -f "$WRAPPER"; }
trap cleanup EXIT

write_wrapper() {
  WRAPPER="$(mktemp "${TMPDIR:-/tmp}/no-undo-beat-XXXXXX.sh")"
  {
    echo '#!/usr/bin/env bash'
    echo "cd '$ROOT'"
    # demo.mjs reads process.env, so the credentials have to be in this shell.
    echo 'set -a; [ -f .env ] && . ./.env; set +a'
    if [ "$1" = "gate" ]; then
      # `gate` parks at the approval gate for the full approvalTimeoutMs
      # (5 min) with nothing on screen. Cut a few seconds after it gets there.
      cat <<'INNER'
# Count first. A presence test passes instantly on any take not preceded by
# `demo.mjs reset`, because the previous take left its own awaiting_approval
# in the chain — the recording then cuts four seconds in, showing nothing.
before=$(grep -c awaiting_approval .demo/esign-audit.jsonl 2>/dev/null || echo 0)
node scripts/demo.mjs gate &
demo=$!
for _ in $(seq 1 300); do
  now=$(grep -c awaiting_approval .demo/esign-audit.jsonl 2>/dev/null || echo 0)
  [ "$now" -gt "$before" ] && break
  kill -0 "$demo" 2>/dev/null || break
  sleep 1
done
sleep 4
pkill -f esign-agent-loop.mjs 2>/dev/null || true
kill "$demo" 2>/dev/null || true
wait "$demo" 2>/dev/null || true
exit 0
INNER
    else
      echo "node scripts/demo.mjs $1"
      echo "sleep 3"
    fi
  } > "$WRAPPER"
  chmod +x "$WRAPPER"
}

BEATS=("$@")
[ ${#BEATS[@]} -eq 0 ] && BEATS=(gate vin crash audit)

for beat in "${BEATS[@]}"; do
  echo "=== recording $beat ==="
  write_wrapper "$beat"
  "$ASCIINEMA" rec --overwrite --cols "$COLS" --rows "$ROWS" \
    --title "No Undo — $beat" --command "$WRAPPER" "$OUT/$beat.cast"

  # demo-subtitles.py has to replay agg's idle capping to know when each line
  # actually appears on screen. Record the values instead of mirroring them in
  # Python, where they silently drift the next time the pacing is tuned.
  idle="$(idle_for "$beat")"; hold="$(hold_for "$beat")"
  printf '{"idle": %s, "hold": %s}\n' "$idle" "$hold" > "$OUT/$beat.render.json"

  "$AGG" --font-dir "$FONTS" --font-family "JetBrains Mono" --theme dracula \
    --font-size 20 --line-height 1.4 --idle-time-limit "$idle" --no-loop \
    --last-frame-duration "$hold" "$OUT/$beat.cast" "$OUT/$beat.gif"

  ffmpeg -y -v error -i "$OUT/$beat.gif" \
    -vf "scale=-2:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x282a36,format=yuv420p" \
    -r 30 -c:v libx264 -preset slow -crf 18 -movflags +faststart "$OUT/$beat.mp4"
  echo "  -> $OUT/$beat.mp4"
done

# Stitch the beats into one reel when all four are present. Subtitles stay in a
# sidecar .srt — never burned in, so the VO timing can be re-cut without
# re-rendering the video.
if [ -f "$OUT/gate.mp4" ] && [ -f "$OUT/vin.mp4" ] && \
   [ -f "$OUT/crash.mp4" ] && [ -f "$OUT/audit.mp4" ]; then
  printf "file '%s'\n" "$OUT"/gate.mp4 "$OUT"/vin.mp4 "$OUT"/crash.mp4 "$OUT"/audit.mp4 \
    > "$OUT/concat.txt"
  ffmpeg -y -v error -f concat -safe 0 -i "$OUT/concat.txt" -c copy "$OUT/reel.mp4"
  rm -f "$OUT/concat.txt"
  echo "  -> $OUT/reel.mp4"
fi

echo
echo "Subtitles: python3 scripts/demo-subtitles.py"
