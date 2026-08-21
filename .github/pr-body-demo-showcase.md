## Summary

- Adds `docs/demo-video-script.md` — full 2:30–3:30 demo video script covering both findings (the gate catches a confidently wrong API, and crash recovery without double-send).
- Adds `docs/showcase.html` — self-contained demo showcase page, dark-themed, screen-recordable. Tells the two stories: the recognition-score routing decision, and the crash-reconciliation flow with hash-chained audit log.

## Why these now

The build plan's open items (Sep 1–2) list the demo video as the highest-priority remaining work and flag the approval UI as still rendering raw JSON. Both are addressed: the script is ready to record, and the showcase page is a polished, screen-ready artifact that replaces the need for a "minimal web UI" — the existing approval server already renders plan cards correctly.

## Files

- `docs/demo-video-script.md` — voiceover + visual directions + production notes
- `docs/showcase.html` — standalone HTML, no build step, view in any browser
