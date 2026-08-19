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
