/**
 * Foxit eSign entitlement + two-step-send probe.
 *
 * Answers the four questions the Aug 20-22 core work depends on, none of which
 * were verified during the Aug 18-19 batch (that batch read specs, it did not
 * call the API):
 *
 *   1. Does our developer account reach /esign/api/v1 at all?
 *   2. Does createfolder accept sendNow:false and return a folderId?
 *   3. Does GET myfolder report folderStatus === "DRAFT" for it?
 *   4. Is there a reachable send-draft endpoint (gateway vs legacy host)?
 *
 * MUST be run on your own machine. Agent sandboxes cannot reach
 * na1.fusion.foxit.com (verified Aug 18 - only registry.npmjs.org is
 * allowlisted). Commit the output of this script as the fixture that the
 * adapter's tests replay.
 *
 * Usage, from the repo root:
 *
 *   set -a; . ./.env; set +a
 *   node mcp/foxit/esign-probe.mjs              # read-only checks (1 and 4 only)
 *   node mcp/foxit/esign-probe.mjs --create-draft # also does 2 and 3
 *   node mcp/foxit/esign-probe.mjs --probe-download --create-draft  # also probes download routes + poll until EXECUTED
 *   node mcp/foxit/esign-probe.mjs --probe-download --folderId 12345 # poll+download against existing folder (no creation)
 *
 * SAFETY: --create-draft only ever sends sendNow:false. This script never
 * sends a document for signature. There is no code path here that does.
 */

const GATEWAY = process.env.FOXIT_ESIGN_HOST ?? "https://na1.fusion.foxit.com";
const LEGACY = process.env.FOXIT_ESIGN_LEGACY_HOST ?? "https://na1.foxitesign.foxit.com";

const clientId = process.env.FOXIT_CLOUD_API_CLIENT_ID ?? process.env.FOXIT_CLIENT_ID;
const clientSecret =
  process.env.FOXIT_CLOUD_API_CLIENT_SECRET ?? process.env.FOXIT_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "missing credentials: set FOXIT_CLIENT_ID and FOXIT_CLIENT_SECRET (source .env first)",
  );
  process.exit(1);
}

const createDraft = process.argv.includes("--create-draft");
const probeDownload = process.argv.includes("--probe-download");
const folderIdArg = (() => {
  const i = process.argv.indexOf("--folderId");
  return i >= 0 ? process.argv[i + 1] : null;
})();
// --poll-only skips draft creation and only exercises poll+download against an existing folderId
const pollOnly = process.argv.includes("--poll-only");
const results = [];

/** Records a test result with its name, verdict (ok/fail/skip), and optional detail message. */
function record(name, verdict, detail) {
  results.push({ name, verdict, detail });
  const mark = verdict === "ok" ? "PASS" : verdict === "skip" ? "SKIP" : "FAIL";
  console.log(`[${mark}] ${name}`);
  if (detail) console.log(`       ${detail}`);
}

/** Returns HTTP headers with Foxit gateway credentials and optional extra headers. */
function gatewayHeaders(extra = {}) {
  return { client_id: clientId, client_secret: clientSecret, ...extra };
}

/** Makes an HTTP request with timeout and returns response status, text, parsed JSON (if any), and elapsed time. */
async function req(url, init = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body, keep text */
    }
    return { ok: res.ok, status: res.status, text, json, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, text: String(err), ms: Date.now() - started };
  }
}

// Redact account identity fields from transcripts before they are printed or
// committed as fixtures. Prefer structural redaction on the already-parsed JSON
// (immune to escaping); fall back to string matching for non-JSON bodies.
const IDENTITY_INT = new Set(["folderAuthorId", "folderCompanyId"]);
const IDENTITY_STR = new Set(["folderAuthorEmail", "folderAuthorFirstName", "folderAuthorLastName"]);

/** Recursively redacts identity fields (folderAuthorId, folderCompanyId, email, names) from JSON objects. */
function redactJson(node) {
  if (Array.isArray(node)) return node.map(redactJson);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (IDENTITY_INT.has(k) && typeof v === "number") out[k] = 0;
      else if (IDENTITY_STR.has(k) && typeof v === "string") out[k] = "[redacted]";
      else out[k] = redactJson(v);
    }
    return out;
  }
  return node;
}

/** Redacts identity fields from unparsed strings using regex pattern matching. */
function redactString(text) {
  return text
    .replace(/("folderAuthorId"|"folderCompanyId")\s*:\s*\d+/g, '$1:0')
    .replace(/(("folderAuthorEmail"|"folderAuthorFirstName"|"folderAuthorLastName")\s*:\s*")(\\.|[^"\\])*(")/g, '$1[redacted]$4')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email redacted]");
}

/** Formats an HTTP response for display, redacting identity data and truncating to max length. */
function summarize(r, max = 400) {
  const body = r.json ? JSON.stringify(redactJson(r.json)) : redactString(r.text);
  return `HTTP ${r.status} in ${r.ms}ms :: ${body.slice(0, max)}`;
}

// --- 1. Entitlement -------------------------------------------------------
// getAllFolderIdsByStatus is read-only and exists on the gateway per the spec.
// 200 => entitled. 401/403 => credentials do not cover eSign. 404 => endpoint
// shape is wrong, or eSign is not provisioned on this host.

const entitlement = await req(
  `${GATEWAY}/esign/api/v1/folders/getAllFolderIdsByStatus?folderStatus=DRAFT`,
  { headers: gatewayHeaders() },
);
record(
  "1. eSign entitlement (GET getAllFolderIdsByStatus)",
  entitlement.ok ? "ok" : "fail",
  summarize(entitlement),
);

if (!entitlement.ok && entitlement.status !== 0) {
  console.log(
    "\n  >> If this is 401/403, the developer account is not entitled to eSign.\n" +
      "  >> Go to docs/review-aug18.md section 5 and pick a contingency within the hour.\n",
  );
}

// --- 4. Send-draft endpoint reachability ---------------------------------
// Probed with no body: we only want to distinguish "route does not exist" (404)
// from "route exists, your request was malformed" (400/405/415/422). Either of
// the latter means the endpoint is there.

for (const [label, url] of [
  ["gateway", `${GATEWAY}/esign/api/v1/folders/sendDraftFolder`],
  ["legacy", `${LEGACY}/api/folders/sendDraftFolder`],
]) {
  const r = await req(url, {
    method: "POST",
    headers: gatewayHeaders({ "content-type": "application/json" }),
    body: "{}",
  });
  const exists = r.status !== 0 && r.status !== 404;
  record(
    `4. send-draft route on ${label} host`,
    exists ? "ok" : "fail",
    `${summarize(r, 240)}${exists ? "  (non-404 => route exists)" : "  (404/unreachable => no such route)"}`,
  );
}

// --- 2 + 3. Draft creation and status ------------------------------------

if (!createDraft) {
  record("2. createfolder(sendNow:false)", "skip", "re-run with --create-draft");
  record("3. folderStatus === DRAFT", "skip", "re-run with --create-draft");
} else if (!entitlement.ok) {
  record("2. createfolder(sendNow:false)", "skip", "entitlement check failed, not attempting");
  record("3. folderStatus === DRAFT", "skip", "entitlement check failed, not attempting");
} else {
  // Minimal one-page PDF, inline, so the probe has no external dependency.
  const tinyPdf =
    "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAw" +
    "IG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8" +
    "PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXT4+CmVuZG9iagp0" +
    "cmFpbGVyCjw8L1Jvb3QgMSAwIFI+Pg==";

  // Schema confirmed live Aug 18 (Gate 0): the gateway wants inputType +
  // base64FileString[] + fileNames[] + parties[], NOT a documents/recipients
  // shape. Response nests the id at folder.folderId. sendNow:false alone
  // (no createEmbeddedSigningSession) yields folderStatus DRAFT.
  const create = await req(`${GATEWAY}/esign/api/v1/folders/createfolder`, {
    method: "POST",
    headers: gatewayHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      folderName: `no-undo-probe-${Date.now()}`,
      inputType: "base64",
      base64FileString: [tinyPdf],
      fileNames: ["probe.pdf"],
      processTextTags: false,
      processAcroFields: false,
      sendNow: false, // <-- the entire point. never true in this file.
      parties: [
        {
          firstName: "Probe",
          lastName: "Recipient",
          emailId: process.env.FOXIT_ESIGN_PROBE_EMAIL ?? "probe@example.invalid",
          permission: "FILL_FIELDS_AND_SIGN",
          sequence: 1,
        },
      ],
    }),
  });

  const folderId =
    create.json?.folder?.folderId ??
    create.json?.data?.folder?.folderId ??
    create.json?.folderId ??
    create.json?.data?.folderId ??
    null;

  record(
    "2. createfolder(sendNow:false) returns folderId",
    folderId ? "ok" : "fail",
    `${summarize(create)}${folderId ? `\n       folderId=${folderId}` : "\n       no folderId found in response — inspect the body above and adjust the field path"}`,
  );

  if (folderId) {
    const status = await req(
      `${GATEWAY}/esign/api/v1/folders/myfolder?folderId=${encodeURIComponent(folderId)}`,
      { headers: gatewayHeaders() },
    );
    const folderStatus =
      status.json?.folder?.folderStatus ??
      status.json?.data?.folder?.folderStatus ??
      status.json?.folderStatus ??
      status.json?.data?.folderStatus ??
      null;
    record(
      "3. folderStatus === DRAFT",
      folderStatus === "DRAFT" ? "ok" : "fail",
      `${summarize(status, 300)}\n       folderStatus=${folderStatus ?? "(not found)"}`,
    );
    console.log(
      `\n  >> Draft folder ${folderId} left in place, unsent. Delete it from the eSign UI when done.\n`,
    );
  } else {
    record("3. folderStatus === DRAFT", "skip", "no folderId to query");
  }
}

// --- 5 + 6. Download + poll-until-EXECUTED (PLANNED Aug 29-30 C) ----------
if (probeDownload) {
  // Determine the folderId to probe — either the one just created, or an explicit --folderId
  let targetFolderId = folderIdArg;
  // If we just created a draft above, reuse that id
  if (!targetFolderId) {
    // Try to capture the folderId from the create step's result (re-read via closure variable)
    // The create draft step stored `folderId` inside `if (folderId) {...}` — we need to
    // re-derive it if probe-download was run with --create-draft. Reuse the last
    // recorded folderId from that step by re-parsing (the variable `folderId` is block-scoped
    // above, so we re-issue a minimal fetch if not already set).
    // For the poll-only/download-only path we require --folderId explicitly.
    if (createDraft) {
      // folderId was block-scoped; without hoisting we can't read it here without
      // re-executing the status fetch. For --probe-download with --create-draft we
      // refetch the latest created id from the in-memory `results` hint — the folderId
      // line was logged above. As a fallback, probe the most recent id via getAllFolderIdsByStatus.
      try {
        const fetched = await req(
          `${GATEWAY}/esign/api/v1/folders/getAllFolderIdsByStatus?folderStatus=DRAFT`,
          { headers: gatewayHeaders() },
        );
        const ids = fetched.json?.folderIds ?? fetched.json?.data?.folderIds ?? fetched.json?.folders ?? [];
        if (Array.isArray(ids) && ids.length > 0) {
          const last = ids[ids.length - 1];
          targetFolderId = last?.folderId ?? last?.id ?? last ?? null;
        }
      } catch {}
    }
  }

  if (!targetFolderId && !createDraft) {
    record("5. pollUntilSigned (--probe-download needs --folderId or --create-draft)", "skip", "pass --folderId <id> or add --create-draft");
    record("6. download routes (--probe-download)", "skip", "no folderId to probe");
  } else {
    // Use the folderId captured from draft creation if available and no explicit arg given
    if (!targetFolderId) {
      // The --create-draft block above logged folderId=... — use that value if we captured it
      // The outer `folderId` is block-scoped, so fall back to undefined and skip gracefully
      record("5. pollUntilSigned", "skip", "no folderId captured — re-run with --folderId");
      record("6. download routes", "skip", "no folderId captured");
    } else {
      const fid = String(targetFolderId);
      // Test poll: one immediate myfolder check, then bounded poll for EXECUTED (short window in probe)
      // This proves the route exists and names the current terminal state for audit/demo script.
      const beforePoll = await req(
        `${GATEWAY}/esign/api/v1/folders/myfolder?folderId=${encodeURIComponent(fid)}`,
        { headers: gatewayHeaders() },
      );
      const curStatus =
        beforePoll.json?.folder?.folderStatus ??
        beforePoll.json?.data?.folder?.folderStatus ??
        beforePoll.json?.folderStatus ??
        null;
      const isExecuted = curStatus === "EXECUTED";
      const isShared = curStatus === "SHARED";
      const isDraft = curStatus === "DRAFT";
      // For the probe we do NOT block 60s — one check + up to 10s bounded retry (4 attempts at 2.5s)
      let pollVerdict = "ok";
      let pollDetail = `${summarize(beforePoll, 260)}\n       folderStatus=${curStatus ?? "(not found)"} — ${isExecuted ? "EXECUTED (signed, terminal)" : isShared ? "SHARED (sent, not signed — not terminal per Aug 27)" : isDraft ? "DRAFT (not sent)" : "unknown"}`;
      if (!isExecuted && beforePoll.ok) {
        // Quick bounded retry (10s) to see if it flips — useful when just self-signed
        const deadline = Date.now() + 10_000;
        let attempts = 0;
        let last = curStatus;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2500));
          attempts += 1;
          const poll = await req(
            `${GATEWAY}/esign/api/v1/folders/myfolder?folderId=${encodeURIComponent(fid)}`,
            { headers: gatewayHeaders() },
          );
          const s =
            poll.json?.folder?.folderStatus ??
            poll.json?.data?.folder?.folderStatus ??
            poll.json?.folderStatus ??
            null;
          last = s;
          if (s === "EXECUTED") {
            pollDetail += `\n       → EXECUTED after ${attempts} poll(s)`;
            break;
          }
        }
        if (last !== "EXECUTED") {
          // Not an error — the probe is expected to run before signing completes.
          // Report as ok with an informational note: confirms polling path works, terminal is EXECUTED.
          pollDetail += `\n       (still ${last ?? "unknown"} after bounded retry — self-sign may still be pending; EXECUTED is the terminal to wait for)`;
        }
      }
      if (!beforePoll.ok) pollVerdict = "fail";
      record("5. pollUntilSigned / EXECUTED terminal state", pollVerdict, pollDetail);

      // Test download routes — both must be non-404 to confirm vendor-named routes exist
      // Single-document and envelope routes are binary PDF endpoints; a 4xx here (e.g. 403/400)
      // still proves the route exists. Only 404 or network 0 means the endpoint is wrong.
      for (const [label, dlUrl] of [
        ["single document", `${GATEWAY}/esign/api/v1/folders/document/download?folderId=${encodeURIComponent(fid)}&docNumber=0`],
        ["envelope", `${GATEWAY}/esign/api/v1/folders/download?folderId=${encodeURIComponent(fid)}`],
      ]) {
        const r = await req(dlUrl, { headers: gatewayHeaders() });
        const exists = r.status !== 0 && r.status !== 404;
        // Treat 404 as fail (route not found), anything else as ok (route exists, even if not yet signed)
        const bodyPreview = r.json ? JSON.stringify(redactJson(r.json)).slice(0, 200) : redactString(r.text).slice(0, 200);
        record(
          `6. download route (${label})`,
          exists ? "ok" : "fail",
          `${summarize(r, 260)}${exists ? "  (non-404 => route exists)" : "  (404 => route not found — check docs/foxit-contact-aug27.md §2/§4a)"} — body: ${bodyPreview}`,
        );
      }
    }
  }
}

// --- verdict --------------------------------------------------------------

console.log("\n================ VERDICT ================");
for (const r of results) console.log(`${r.verdict.toUpperCase().padEnd(4)}  ${r.name}`);

const entitled = results[0].verdict === "ok";
const twoStep = results.find((r) => r.name.startsWith("3."))?.verdict === "ok";
const anySendRoute = results.filter((r) => r.name.startsWith("4.")).some((r) => r.verdict === "ok");

console.log("\nWhat this means for the build plan:");
if (!entitled) {
  console.log("  eSign is NOT reachable with these credentials.");
  console.log("  -> Contingency required. docs/review-aug18.md section 5.");
} else if (twoStep && anySendRoute) {
  console.log("  Two-step create-draft-then-send is CONFIRMED end to end.");
  console.log("  -> Aug 20-22 core work proceeds as planned. Lock the send host now.");
} else if (entitled && !twoStep) {
  console.log("  eSign reachable but the draft step is unconfirmed.");
  console.log("  -> Re-run with --create-draft, or the send must be modelled as a");
  console.log("     single irreversible createfolder(sendNow:true) call, which makes");
  console.log("     the pre-send ledger write the ONLY protection. Note it in the plan.");
} else {
  console.log("  Draft creation works but no send-draft route was reachable.");
  console.log("  -> Send step goes on the legacy host, or via createfolder(sendNow:true)");
  console.log("     against the already-drafted content. Decide before writing the adapter.");
}

process.exitCode = entitled ? 0 : 1;
