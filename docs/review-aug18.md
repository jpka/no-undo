# Project state review — Aug 18, end of first batch

Trigger: first batch (build-plan "Aug 18–19 — Unblock everything") reported done. This is the
audit of what is actually true, what is assumed, and what changes in the plan as a result.

---

## 1. What is shipped and verified

| Item | State | Evidence |
| --- | --- | --- |
| Repo scaffold, agent working notes | done | `981c466` |
| Foxit + Nutrient accounts, keys in `.env` (gitignored) | done | `.env` present, 3 keys |
| Foxit **PDF Services** MCP running against our keys | **verified live** | 40 tools listed; `pdf_from_url` → `get_task_result` → `completed` |
| No signing tool in the Foxit MCP toolset | **verified live** | `tools/list` enumeration |
| Foxit MCP pinned at exact `1.1.2`, no unpinned `npx -y` | done | `mcp/foxit/package.json`, lockfile committed |
| Idempotency decision written and locked | done | `docs/aug18-19.md` §"The locked decision" |
| PR workflow per `AGENTS.md` exercised end to end | done | PR #1, one CodeRabbit round addressed, merged |

The batch landed on **Aug 18**, ahead of its Aug 18–19 window — roughly **2h of slack recovered**
against a 6h budget. That slack is spent on Gate 0 below, not banked.

## 2. What is assumed, not verified

This is the part that matters. The Aug 18–19 doc is excellent research, but §2 (eSign) and §3
(Nutrient) are **entirely spec-reading and blog-reading**. No byte has crossed the wire to either
API. Four assumptions are currently load-bearing and untested:

1. **Our self-serve Foxit developer account is entitled to eSign at all.** PDF Services and eSign
   are separately provisioned products. Nothing verified that `client_id`/`client_secret` opens
   `/esign/api/v1`. If it does not, the entire submission thesis — "the one irreversible step is a
   signature send" — has no API behind it.
2. **`createfolder` accepts `sendNow:false` and returns a `folderId` synchronously.** The whole
   two-step crash-safe send depends on this. Read from the spec, never executed.
3. **The gateway flavor has some way to send an existing draft.** `docs/aug18-19.md` already flags
   that no gateway send-draft endpoint is documented and that the legacy host may be required.
   That is not a detail to settle "during adapter work" — it decides whether the two-step flow
   exists at all, and therefore whether the demo's core claim is demonstrable.
4. **Nutrient's Data Extraction returns per-span confidence scores we can threshold.** The entire
   Nutrient-track argument ("load-bearing, not decorative") rests on confidence-routed approval.
   Data Extraction has *no OpenAPI spec* — docs only, per our own §3. Unverified.

Two smaller ones, already visible in our own notes and worth restating because they bite later:

- Async `/build` idempotency is **"not supported on test keys."** A free-tier key is plausibly a
  test key. Impact is low — the locked baseline is a client-side ledger regardless — but it means
  the one server-side idempotency mechanism we found may be unavailable to us in practice.
- Webhook delivery is not deduped; the handler must dedupe on `(folderId, event_name)`. Currently
  written down but not in any day's task list.

## 3. Environment constraint discovered today

**Agent sandboxes cannot reach the vendor APIs.** Verified: `na1.fusion.foxit.com` and
`api.nutrient.io` both fail to connect from the sandbox; `registry.npmjs.org` returns 200. Only
the npm registry is allowlisted.

Consequences, and they reshape how the remaining batches are delegated:

- Any live-API verification is **human-run, on your machine**. Subagents can write the probe, the
  adapter, and the tests; they cannot execute anything that touches Foxit or Nutrient.
- Therefore every vendor adapter needs a **fixture/mock seam from day one**, not retrofitted at
  test-writing time. Agents test against recorded fixtures; you run the live script and paste back
  the transcript.
- Every stage should ship a single `node scripts/<stage>-probe.mjs` you run in one command, with
  its output committed as the fixture. This is also free demo material and free judge-facing
  reproducibility.

## 4. Plan defects found

**a. The critical-path repo is not here.** `safe-write-mcp-core` — the thing Aug 20–22 modifies, the
only never-cut item — is not checked out in this workspace. Decision taken: keep it as its own repo
(it is published, and servers A and C consume it) and check it out alongside `No Undo`. Until that
happens, the next batch cannot start.

**b. eSign discovery is scheduled five days too late.** Assumption 1 above is the single
project-killing unknown and the plan surfaces it on Aug 23, after 14 hours of core work has been
spent. Moved to a blocking probe before core work begins.

**c. A cross-batch dependency is mis-ordered.** Aug 20–22 asks the core to implement "two-step eSign
send" while Aug 23–25 owns the gateway-vs-legacy decision. `docs/aug18-19.md` argues the ledger
contract is identical either way, which is right about the *ledger* and wrong about
`confirmExecuted()`: its reconciliation call differs by host. Fix is cheap and improves the design —
make reconciliation a **host-supplied callback**, exactly like the existing host-supplied
`renderPlan` seam. The core then never names a vendor, which is also the portfolio-reuse argument
the original pitch asked for.

**d. No contingency for "eSign unavailable."** The cut list handles running out of time. It does not
handle the API not existing for us. Written below.

**e. Process overhead is unbudgeted.** `AGENTS.md` mandates PR + CI + review-round + merge per
session. PR #1 took one CodeRabbit round. At ~40 min per batch across ~8 remaining batches that is
~5h currently being paid out of coding time.

**f. The budget does not close.** Counting the revision: ~62h of day-by-day coding, ~5h of the
overhead in (e), and an Aug 31 feature-freeze day with no estimate at all — against a stated ~60h.
Roughly **70 vs 60**. This is not a reason to re-plan; it is the reason the cut list must actually
be used rather than admired, and the reason only two items are marked never-cut.

## 5. Contingency: if eSign is not available to us

Ranked, decide within one hour of the probe failing:

1. **Foxit eSign free-trial / separate signup.** Fastest if it exists; changes nothing else.
2. **Re-target the irreversible action to Foxit PDF Services' genuinely destructive tools.** The
   toolset includes delete, password-protect, and flatten. `delete` of an uploaded document and
   `protect` with a password are both practically irreversible. The demo becomes "agent proposes an
   unrecoverable document operation" — weaker headline, same engineering, still on-brief for a
   challenge titled *"Your Agent Shouldn't Sign That"*, and still a legitimate Foxit-track entry.
3. **Nutrient-only submission plus Overall.** Extraction-with-confidence + redaction, with the gate
   on redaction (destructive by construction — redaction removes data). Drops the Foxit track.

Option 2 is the one to pre-write, because it preserves all three entries and reuses every line of
core work. It costs nothing to keep in the back pocket.

## 6. What did not change

The technical thesis holds and is still the best thing about this project. `consume()` being
causally disconnected from the side effect is a real bug, the `DECISIONS.md` rationale really is
inverted for un-undoable APIs, and *kill the process mid-send and show it doesn't double-send* is
still a demo nobody else will run. Nothing found today weakens that. The revisions are all about
making sure there is a live API underneath it before 14 hours go into the core.
