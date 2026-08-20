## What changed

Built the Foxit eSign adapter in `mcp/foxit/esign-adapter.mjs` that consumes `safe-write-mcp-core` v0.2's crash-safe lifecycle.

## How it works

The adapter exposes four main functions that map to the core's two-step execute lifecycle:

- **`createEsignFolder()`** — calls `createfolder(sendNow:false)`, gets a `folderId`, creates a plan token bound to the payload fingerprint, returns both.
- **`beginEsignSend()`** — transitions the plan to `executing` state via `store.beginExecute()`. The host then calls `sendDraftFolder()`.
- **`confirmEsignExecuted()`** — marks the plan used, audits `executed`. Called after the gateway send succeeds.
- **`confirmEsignFailed()`** — releases the plan back to retryable (not marked used). Called when the send fails.

## Crash safety

- **Reconcile callback**: if the process dies mid-send, `PlanStore.fromJournal()` recovers the stuck-executing plan and calls our reconcile hook, which checks the gateway `folderStatus`:
  - `DRAFT` → `"not-done"` (send did not happen, retry)
  - `SHARED` → `"done"` (send happened, mark executed)
  - Unreachable → `"unknown"` (plan stays queryable via `listExecuting()`)

- **Webhook dedup**: tracks `(folderId, event_name)` pairs in a `Set` to prevent double-processing of gateway retry events.

- **Journal**: the core records every state transition (previewed → approved → executing → executed/failed) to a durable JSONL file, so a restart can detect and reconcile stuck executions.

## Files

- `mcp/foxit/esign-adapter.mjs` — new, 370 lines, pure ESM JavaScript (no TypeScript annotations that would break Node's `.mjs` loader)
- Re-exports `PlanStore`, `checkFolderStatus` for the agent's MCP tool wiring

## Next steps

- Wire the adapter to the Foxit MCP server's tool surface (the agent calls these functions as MCP tools)
- Add the approval UI for the eSign send (renders document + recipients, not JSON)
- Build the Nutrient stage (Aug 26–28, requires Data Extraction key)
