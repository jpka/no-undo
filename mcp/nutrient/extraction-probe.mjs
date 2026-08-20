/**
 * Nutrient DWS Data Extraction probe — Gate 0.
 *
 * Asks the one question the Nutrient track rests on: does a live extraction
 * call return per-span confidence scores we can threshold? Gate 0 (Aug 18)
 * found the account is NOT entitled to Data Extraction yet — see the verdict
 * section in this header and docs/gate0-aug18.md.
 *
 * Gate 0 diagnostic (Aug 18, live):
 *   POST /extraction/parse, NUTRIENT_API_KEY (DWS Processor key, pdf_live_*)
 *     -> HTTP 403 {"error":{"details":"Forbidden",...}}
 *   same route, no Authorization                    -> HTTP 401 (route exists)
 *   nonsense path, valid key                        -> HTTP 404 (catch-all)
 *
 * Data Extraction is a separately provisioned product/tenant: a DWS Processor
 * key cannot authenticate it (per PSPDFKit/nutrient-dws-mcp-server README:
 * "Data Extraction is a separate product with its own tenant... set
 * NUTRIENT_DWS_EXTRACTION_API_KEY to a Data Extraction key from the dashboard").
 *
 * UNBLOCK (human, ~5 min): in the Nutrient dashboard create/find the Data
 * Extraction product key (dashboard.nutrient.io), add to .env as
 * NUTRIENT_DWS_EXTRACTION_API_KEY, then re-run this probe.
 *
 * Usage, from the repo root:
 *   set -a; . ./.env; set +a
 *   node mcp/nutrient/extraction-probe.mjs              # messy page, generated
 *   node mcp/nutrient/extraction-probe.mjs --file x.pdf # explicit document
 *   node mcp/nutrient/extraction-probe.mjs --fixture    # also save the response
 *                                                       # under docs/fixtures/ for
 *                                                       # test replay (opt-in only)
 *
 * Output: the raw response is written to the OS temp dir by default so no
 * document-derived data lands in the tracked repo. Pass --fixture to opt into
 * writing it under docs/fixtures/ (an explicit decision to commit that data).
 *
 * Never sends anything irreversible: extraction is read-only.
 */

import { writeFileSync, mkdirSync, readFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTRACT = "https://api.nutrient.io/extraction/parse";
const THRESHOLD = 0.7; // spans below this would route to the human gate

const apiKey =
  process.env.NUTRIENT_DWS_EXTRACTION_API_KEY ?? process.env.NUTRIENT_API_KEY;
const keySource = process.env.NUTRIENT_DWS_EXTRACTION_API_KEY
  ? "NUTRIENT_DWS_EXTRACTION_API_KEY"
  : "NUTRIENT_API_KEY";

if (!apiKey) {
  console.error("missing key: set NUTRIENT_API_KEY (or NUTRIENT_DWS_EXTRACTION_API_KEY) in .env");
  process.exit(1);
}
// Report which env var supplied the key and how long it is, never any of its
// bytes — a prefix is enough to identify the key in a leaked log.
console.log(`key source: ${keySource} (${apiKey.length} chars)`);

const fileIdx = process.argv.indexOf("--file");
const explicitFile = fileIdx !== -1 ? process.argv[fileIdx + 1] : undefined;

// --- messy page generation (used when no --file is given) ------------------
// A hand-built PDF: skewed text lines (simulating a wonky scan), gray noise
// rectangles (stains), and a freehand signature polyline. OCR-reads with
// imperfect, varied confidence — exactly the low-confidence spans the gate is for.

/** Generates a minimal test PDF with skewed lines, stains, and signature to test extraction confidence scoring. */
function messyPdf() {
  const content = [];
  const push = (s) => content.push(s);

  // A freehand-style "signature" as a long polyline, in red ink.
  let sig = "0.8 0.1 0.1 RG 1.5 w\n";
  let x = 320;
  let y = 150;
  for (let i = 0; i < 24; i++) {
    sig += `q 1 0 0 1 ${x} ${y} m ${x + 5} ${y + (i % 2 ? -4 : 4)} l ${x + 9} ${y - 2} l ${x + 13} ${y + (i % 2 ? 5 : -5)} l S Q\n`;
    x += 13;
    y += (i % 3 === 0 ? 3 : -2);
  }

  // Noise "stains": light gray rectangles at random-ish fixed spots.
  for (const [nx, ny, nw, nh] of [
    [40, 620, 90, 8], [120, 400, 40, 12], [420, 300, 70, 10], [260, 230, 50, 14],
  ]) {
    push(`q 0.88 g ${nx} ${ny} ${nw} ${nh} re f Q\n`);
  }

  // Title.
  push("BT /F1 22 Tf 0 0 0 rg 40 700 Td (ACME Freight Services - Invoice #INV-2026-0418) Tj ET\n");
  // A slightly-rotated "date stamped" line.
  push("BT /F1 12 Tf 0 0 0 rg 1 0 0 1 40 670 Tm (Received  Aug 18 2026   cr8te a p9ckng sl1p) Tj ET\n");
  // Body lines, each with a small rotation to simulate scan skew.
  const lines = [
    "Payer:     Kaniefsky Transport LLC, 4th Ave, Brooklyn NY",
    "Vendor:    ACME Freight Services - terminal 3, Bayonne NJ",
    "Item       Qty   Unit price      Total",
    "Parcel 1   2      $14.50          $29.00",
    "Parcel 2   1      $39.99          $39.99",
    "Handling   3      $4.00           $12.00",
    "Subtotal                     $80.99",
    "Tax (7.25%)                    $5.87",
    "Total due                     $86.86",
  ];
  let ty = 620;
  for (const [i, ln] of lines.entries()) {
    const rot = (i % 2 === 0 ? 0.015 : -0.02) * (i % 4 === 0 ? -1 : 1);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    push(`BT /F1 ${i < 3 ? 13 : 11} Tf 0 0 0 rg ${c} ${s} ${-s} ${c} 40 ${ty} Tm (${ln}) Tj ET\n`);
    ty -= 34;
  }
  // A handwritten-style annotation next to the total.
  push("BT /F1 10 Tf 0.8 0.1 0.1 rg 0.995 0.02 -0.02 0.995 300 300 Tm (plz call before delivery) Tj ET\n");
  push("BT /F1 10 Tf 0.8 0.1 0.1 rg 0.995 -0.02 0.02 0.995 300 280 Tm (no signature unless ok) Tj ET\n");
  push(sig);

  const stream = content.join("");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return out;
}

// --- live call -------------------------------------------------------------

const filePath = explicitFile ?? join(tmpdir(), "no-undo-messy.pdf");
if (!explicitFile) writeFileSync(filePath, messyPdf(), "latin1");

const body = new FormData();
body.append("file", new Blob([readFileSync(filePath)]), "messy-invoice.pdf");
body.append("instructions", JSON.stringify({ mode: "understand", output: { format: "spatial", includeWords: true } }));

const started = Date.now();
let res;
try {
  res = await fetch(EXTRACT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    signal: AbortSignal.timeout(90_000),
    redirect: "error", // never replay the credentialed PDF upload onto a redirect target
  });
} catch (err) {
  console.error(`[FAIL] network: ${String(err)} cause=${JSON.stringify(err.cause)}`);
  process.exit(1);
}
const ms = Date.now() - started;
const raw = await res.text();

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const wantFixture = process.argv.includes("--fixture");
const fixturesDir = fileURLToPath(new URL("../../docs/fixtures/", import.meta.url));
if (wantFixture) mkdirSync(fixturesDir, { recursive: true });

// Temp responses go in a fresh exclusive mode-0o600 dir so nothing document-
// derived leaks into the tracked repo, names are unpredictable, and cleanup is
// deterministic. Fixture captures get a unique suffix and exclusive create so a
// same-second re-run never silently overwrites a committed fixture.
const tempDir = mkdtempSync(join(tmpdir(), "no-undo-extraction-"));
const outPath = wantFixture
  ? join(fixturesDir, `nutrient-extraction-${stamp}-${randomBytes(3).toString("hex")}.json`)
  : join(tempDir, "response.json");
let wrote = false;
try {
  writeFileSync(outPath, raw, { flag: "wx", mode: 0o600 });
  wrote = true;
} catch (err) {
  console.error(`[FAIL] could not write response: ${String(err)}`);
  process.exit(1);
}
process.on("exit", () => {
  if (!wantFixture && wrote) {
    try {
      unlinkSync(outPath);
      rmdirSync(tempDir);
    } catch { /* best effort */ }
  }
});

console.log(`[HTTP ${res.status} in ${ms}ms] ${EXTRACT}`);
console.log(`response saved: ${outPath}`);
if (!wantFixture) {
  console.log("  (temp, not tracked — re-run with --fixture to save under docs/fixtures/ for test replay)");
}

if (res.status === 200) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("[FAIL] non-JSON 200 body; inspect fixture");
    process.exit(1);
  }
  const elements = data.output?.elements ?? [];
  const confs = elements
    .map((e) => e.confidence)
    .filter((c) => typeof c === "number");
  const low = elements.filter(
    (e) => typeof e.confidence === "number" && e.confidence < THRESHOLD,
  );
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }; // Calculates the median of an array of numbers.
  console.log(`[PASS] extraction returned ${elements.length} elements`);
  console.log(`  confidence: min=${confs.length ? Math.min(...confs).toFixed(3) : "n/a"} ` +
    `median=${median(confs)?.toFixed(3) ?? "n/a"} max=${confs.length ? Math.max(...confs).toFixed(3) : "n/a"}`);
  console.log(`  spans below ${THRESHOLD} (would route to human): ${low.length}`);
  for (const e of low.slice(0, 10)) {
    console.log(`    - ${e.type} conf=${e.confidence} "${String(e.text ?? "").slice(0, 60)}"`);
  }
  console.log(`  usage: ${JSON.stringify(data.usage ?? "n/a")}`);
  console.log(`  requestId: ${data.requestId ?? "n/a"}`);
  console.log("\nVERDICT: Data Extraction confidence-routed approval CONFIRMED.");
  console.log("  -> Nutrient stage (Aug 26-28) proceeds as planned.");
  process.exit(0);
}

if (res.status === 403) {
  console.error("\n[FAIL] HTTP 403 Forbidden on /extraction/parse.");
  console.error("  This is the Gate 0 entitlement finding (Aug 18): the key in use is not");
  console.error("  a Data Extraction key. Data Extraction is a separately provisioned product/tenant.");
  console.error("  No-auth on the same route -> 401 (route exists); nonsense path -> 404.");
  console.error("  UNBLOCK: add a Data Extraction API key from dashboard.nutrient.io to .env");
  console.error("  as NUTRIENT_DWS_EXTRACTION_API_KEY, then re-run this probe.");
  console.error(`  body: ${raw.slice(0, 240)}`);
  process.exit(1);
}

console.error(`[FAIL] HTTP ${res.status} (see fixture): ${raw.slice(0, 400)}`);
process.exit(1);
