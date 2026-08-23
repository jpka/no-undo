## Summary

- Bumps `safe-write-mcp-core` from `0.2.0` to `0.3.0` to consume the fix for the `GET /api/plans` raw-payload leak ([`safe-write-mcp-core#18`](https://github.com/jpka/safe-write-mcp-core/issues/18), closed by [`safe-write-mcp-core#19`](https://github.com/jpka/safe-write-mcp-core/pull/19)).
- v0.3.0 drops the raw `payload` field from `GET /api/plans` by default — opt-in via `exposeRawPayload`. This was an Aug 29–30 audit/UI task that was filed in the wrong repo; it's a core response-shape leak, not a local one.
- Updates `build-plan.md`: marks the leak fix as DONE, refreshes the status line, and replaces the outdated Aug 20 correction note with a pointer to the published package.

## Why this matters

The leak was confirmed by live reproduction: a `renderPlan` hook surfacing only the folder name still returned an SSN and the full recipient list over `GET /api/plans`. Servers A and C have the same leak since it was in the published package — they inherit the fix on their next bump.

## Verification

- All 7 eSign adapter tests pass against v0.3.0.
- `renderEsignPlan` reads `plan.payload` from the server-side plan object (not the API response), so the v0.3.0 response-shape change is a clean bump with no hook changes needed.
