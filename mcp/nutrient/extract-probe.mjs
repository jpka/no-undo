/**
 * Nutrient DWS Data Extraction — schema-based `/extraction/extract` probe
 * and per-mode calibration harness.
 *
 * WHY THIS EXISTS SEPARATELY FROM extraction-probe.mjs
 * ----------------------------------------------------
 * Gate 0's probe calls `/extraction/parse`, which returns layout *elements*
 * with a composite per-element `confidence` — and nothing else. The routing
 * design in the build plan (Aug 26–28) is built on the per-field **match
 * label** (`id_match` / `id_match_multiblock` / `id_match_partial` /
 * `fuzzy_match` / `not_found`) and on `confidenceComponents`. Those signals
 * are only emitted by `/extraction/extract`, on `output.metadata`, and only
 * when `options.includeCitations` is true (the default).
 *
 * So `/parse` cannot calibrate the gate. This probe is the one that can.
 *
 * WHAT IT DOES
 *   1. POSTs the messy document to /extraction/extract with an invoice schema.
 *   2. Walks output.data alongside output.metadata (they mirror each other) and
 *      prints every scalar field's value, match label, confidence, and
 *      confidenceComponents.
 *   3. Applies the adapter's real routing decision to each field and prints
 *      whether it would auto-approve or go to the human.
 *   4. With --calibrate, repeats across parseConfig.mode = structure /
 *      understand / agentic and prints the comparison table the Nutrient SE
 *      asked for (where the fuzzy_match / not_found / low-confidence rates
 *      land per mode) before thresholds get locked.
 *
 * The schema deliberately asks for two fields the document does not contain
 * (`due_date`, `po_number`) so `not_found` routing is actually exercised
 * rather than assumed.
 *
 * Usage, from the repo root:
 *   set -a; . ./.env; set +a
 *   node mcp/nutrient/extract-probe.mjs                    # single understand run
 *   node mcp/nutrient/extract-probe.mjs --mode agentic
 *   node mcp/nutrient/extract-probe.mjs --file invoice.pdf
 *   node mcp/nutrient/extract-probe.mjs --calibrate         # all three modes
 *   node mcp/nutrient/extract-probe.mjs --calibrate --fixture
 *
 * COST WARNING: --calibrate runs structure (1.5 cr/page) + understand
 * (9 cr/page) + agentic (18 cr/page) = ~28.5 credits per page, per run.
 *
 * Output goes to an exclusive mode-0o600 temp dir by default so nothing
 * document-derived lands in the tracked repo. Pass --fixture to opt into
 * writing under docs/fixtures/ — an explicit decision to commit that data.
 *
 * Never sends anything irreversible: extraction is read-only.
 */

import { writeFileSync, writeSync, mkdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { messyPdf } from "./messy-pdf.mjs";
import { routeFields, summarizeRouting, INVOICE_SCHEMA } from "./extraction-adapter.mjs";

const EXTRACT = "https://api.nutrient.io/extraction/extract";
const API_VERSION = "2026-05-25";
const MODES = ["structure", "understand", "agentic"];

const apiKey =
  process.env.NUTRIENT_DWS_EXTRACTION_API_KEY ?? process.env.NUTRIENT_API_KEY;
const keySource = process.env.NUTRIENT_DWS_EXTRACTION_API_KEY
  ? "NUTRIENT_DWS_EXTRACTION_API_KEY"
  : "NUTRIENT_API_KEY";

if (!apiKey) {
  console.error(
    "missing key: set NUTRIENT_DWS_EXTRACTION_API_KEY (or NUTRIENT_API_KEY) in .env",
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
/** @param {string} flag */
function flagValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}
const explicitFile = flagValue("--file");
const wantFixture = argv.includes("--fixture");
const wantCalibrate = argv.includes("--calibrate");
const singleMode = flagValue("--mode") ?? "understand";

if (!wantCalibrate && !MODES.includes(singleMode)) {
  writeSync(2, `--mode must be one of ${MODES.join(", ")} (extract rejects "text")\n`);
  process.exit(1);
}

// Logs the env var the key came from and its length. Never any of the key's
// bytes: even a short prefix is enough to identify a key in a leaked log.
console.log(`key source: ${keySource} (${apiKey.length} chars)`);

// --- document ---------------------------------------------------------------

const filePath = explicitFile ?? join(tmpdir(), "no-undo-messy.pdf");
if (!explicitFile) writeFileSync(filePath, messyPdf(), "latin1");
const fileBytes = readFileSync(filePath);
const docLabel = explicitFile ? "explicit --file" : "generated messy invoice";

// --- output location --------------------------------------------------------

const fixturesDir = fileURLToPath(new URL("../../docs/fixtures/", import.meta.url));
if (wantFixture) mkdirSync(fixturesDir, { recursive: true });
// Temp responses go in a fresh exclusive dir so names are unpredictable and
// cleanup is deterministic; nothing document-derived reaches the tracked repo.
const tempDir = mkdtempSync(join(tmpdir(), "no-undo-extract-"));
process.on("exit", () => {
  if (!wantFixture) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/**
 * Write a response body, never overwriting an existing committed fixture.
 * @param {string} mode
 * @param {string} raw
 * @returns {string} path written
 */
function saveResponse(mode, raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = wantFixture
    ? join(
        fixturesDir,
        `nutrient-extract-${mode}-${stamp}-${randomBytes(3).toString("hex")}.json`,
      )
    : join(tempDir, `extract-${mode}.json`);
  writeFileSync(path, raw, { flag: "wx", mode: 0o600 });
  return path;
}

// --- one extract call -------------------------------------------------------

/**
 * @param {string} mode
 * @returns {Promise<{mode: string, status: number, ms: number, raw: string, data?: any}>}
 */
async function extractOnce(mode) {
  const instructions = {
    schema: INVOICE_SCHEMA,
    parseConfig: { mode },
    options: { includeCitations: true, strict: false, multimodal: false },
  };

  const body = new FormData();
  body.append("file", new Blob([fileBytes]), "messy-invoice.pdf");
  body.append("instructions", JSON.stringify(instructions));

  const started = Date.now();
  let res;
  try {
    res = await fetch(EXTRACT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-nutrient-api-version": API_VERSION,
      },
      body,
      signal: AbortSignal.timeout(180_000),
      redirect: "error", // never replay the credentialed upload onto a redirect target
    });
  } catch (err) {
    return {
      mode,
      status: 0,
      ms: Date.now() - started,
      raw: `network error: ${String(err)} cause=${JSON.stringify(err.cause)}`,
    };
  }
  const ms = Date.now() - started;
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    /* non-JSON body — reported by the caller via status/raw */
  }
  return { mode, status: res.status, ms, raw, data };
}

// --- reporting --------------------------------------------------------------

/**
 * @param {ReturnType<typeof routeFields>} routed
 */
function printFields(routed) {
  for (const f of routed.fields) {
    const conf = f.confidence == null ? "—" : f.confidence.toFixed(3);
    const grounding =
      f.confidenceComponents?.groundingScore == null
        ? "—"
        : f.confidenceComponents.groundingScore.toFixed(3);
    const recog = f.recognitionScore == null ? "—" : f.recognitionScore.toFixed(3);
    const decision = f.route === "auto" ? "auto " : "HUMAN";
    console.log(
      `    ${decision} ${f.field.padEnd(26)} match=${String(f.match ?? "—").padEnd(20)} ` +
        `conf=${conf.padStart(6)} ground=${grounding.padStart(6)} recog=${recog.padStart(6)}`,
    );
    console.log(`          ${f.reason}`);
    if (f.valuePresent) {
      console.log(`          value: ${JSON.stringify(f.value).slice(0, 100)}`);
    } else {
      console.log("          value: (absent from output.data)");
    }
  }
}

/**
 * @param {{mode: string, status: number, ms: number, raw: string, data?: any}} result
 * @returns {{ok: boolean, summary?: any, path?: string}}
 */
function report(result) {
  const path = saveResponse(result.mode, result.raw);
  console.log(`\n=== mode: ${result.mode} — HTTP ${result.status} in ${result.ms}ms`);
  console.log(`    response saved: ${path}`);
  if (!wantFixture) {
    console.log("    (temp, not tracked — re-run with --fixture to commit under docs/fixtures/)");
  }

  if (result.status !== 200) {
    console.error(`    [FAIL] ${result.raw.slice(0, 400)}`);
    if (result.status === 403) {
      console.error(
        "    403 = the key in use is not entitled to Data Extraction. Data Extraction is a\n" +
          "    separately provisioned product/tenant; add a Data Extraction key from\n" +
          "    dashboard.nutrient.io to .env as NUTRIENT_DWS_EXTRACTION_API_KEY.",
      );
    }
    return { ok: false, path };
  }

  const output = result.data?.output ?? {};
  const routed = routeFields(output.data ?? {}, output.metadata ?? {}, {
    documentType: "invoice",
  });
  const summary = summarizeRouting(routed);

  console.log(
    `    thresholds: ${routed.limits.documentType} ` +
      `conf>=${routed.limits.confidence} ground>=${routed.limits.grounding} ` +
      `recog>=${routed.limits.recognition} (calibrated: ${routed.limits.calibrated})`,
  );
  console.log(`    fields: ${summary.total}  auto: ${summary.auto}  human: ${summary.human}`);
  console.log(`    match labels: ${JSON.stringify(summary.byMatch)}`);
  console.log(
    `    confidence: min=${summary.confidence.min?.toFixed(3) ?? "n/a"} ` +
      `median=${summary.confidence.median?.toFixed(3) ?? "n/a"} ` +
      `max=${summary.confidence.max?.toFixed(3) ?? "n/a"} ` +
      `absent=${summary.confidence.absent}`,
  );
  console.log(
    `    recognition: min=${summary.recognition.min?.toFixed(3) ?? "n/a"} ` +
      `median=${summary.recognition.median?.toFixed(3) ?? "n/a"} ` +
      `absent=${summary.recognition.absent}  ` +
      `vetoed by OCR floor: ${summary.savedByRecognition}`,
  );
  console.log(`    usage: ${JSON.stringify(result.data?.usage ?? "n/a")}`);
  console.log(`    requestId: ${result.data?.requestId ?? "n/a"}`);
  printFields(routed);
  return { ok: true, summary, path };
}

// --- main -------------------------------------------------------------------

console.log(`document: ${docLabel} (${fileBytes.length} bytes)`);
console.log(`endpoint: ${EXTRACT} (api version ${API_VERSION})`);

const modesToRun = wantCalibrate ? MODES : [singleMode];
if (wantCalibrate) {
  console.log(
    "\nCALIBRATION RUN — structure + understand + agentic.\n" +
      "Cost is roughly 28.5 extraction credits per page for the set.",
  );
}

/** @type {Array<{mode: string, ok: boolean, summary?: any}>} */
const results = [];
for (const mode of modesToRun) {
  const raw = await extractOnce(mode);
  const r = report(raw);
  results.push({ mode, ok: r.ok, summary: r.summary });
}

const good = results.filter((r) => r.ok);

if (wantCalibrate && good.length) {
  console.log("\n=== CALIBRATION TABLE ===");
  console.log(
    "mode        fields  auto  human  fuzzy  not_found  id_match  conf(med)  recog(min)  ocr-veto",
  );
  for (const r of good) {
    const s = r.summary;
    console.log(
      `${r.mode.padEnd(12)}${String(s.total).padStart(6)}${String(s.auto).padStart(6)}` +
        `${String(s.human).padStart(7)}${String(s.byMatch.fuzzy_match ?? 0).padStart(7)}` +
        `${String(s.byMatch.not_found ?? 0).padStart(11)}` +
        `${String(s.byMatch.id_match ?? 0).padStart(10)}` +
        `${(s.confidence.median?.toFixed(3) ?? "n/a").padStart(11)}` +
        `${(s.recognition.min?.toFixed(3) ?? "n/a").padStart(12)}` +
        `${String(s.savedByRecognition).padStart(10)}`,
    );
  }
  console.log(
    "\nRead this table before locking a confidence threshold. Per the Nutrient SE\n" +
      "(docs/nutrient-support-aug20.md): the score is relative and uncalibrated, so\n" +
      "the cutoff is only meaningful next to the match-label rates in the same row.\n" +
      "The ocr-veto column counts fields that every grounding signal cleared and only\n" +
      "recognitionScore caught — if it is non-zero, the composite score alone would\n" +
      "have auto-approved a misread value.",
  );
}

if (!good.length) {
  writeSync(2, "\nVERDICT: no mode returned 200 — see the diagnostics above.\n");
  process.exit(1);
}

console.log(
  `\nVERDICT: schema extraction with per-field match labels CONFIRMED on ` +
    `${good.map((r) => r.mode).join(", ")}.`,
);
process.exit(0);
