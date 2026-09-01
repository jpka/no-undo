#!/usr/bin/env node
/**
 * Demo driver — one command per recorded beat.
 *
 * Recording a live pipeline by hand is where takes die: a mistyped flag, a
 * stale journal from the previous attempt, a crash you have to time with
 * `kill -9`. Every beat here is a single command, reproducible, with the
 * environment reset in front of it, so a retake is the same keystroke.
 *
 *   node scripts/demo.mjs check    — credentials + preflight, spends nothing
 *   node scripts/demo.mjs reset    — fresh journal, no state from earlier takes
 *   node scripts/demo.mjs gate     — prompt → assembly → extraction → redaction
 *                                    → verify → gate. Stops at the approval URL.
 *   node scripts/demo.mjs vin      — the VIN finding, live, side by side
 *   node scripts/demo.mjs crash    — crash mid-send, restart, reconcile
 *   node scripts/demo.mjs audit    — hash-chained audit trail + tamper detection
 *
 * `gate` and `crash` create real DRAFT folders in Foxit eSign (reversible).
 * Only approving in the browser sends anything.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const JOURNAL = resolve(ROOT, ".demo/demo-journal.jsonl");
// The sink derives this from the journal path via defaultAuditPath(journal,
// "esign") — {journalDir}/esign-audit.jsonl. Hardcoding a different name here
// meant the audit beat looked for a file nothing ever wrote.
const AUDIT = resolve(ROOT, ".demo/esign-audit.jsonl");
const TOKENMAP = resolve(ROOT, ".demo/.token-map.json");

const PROMPT =
  "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function banner(title, subtitle) {
  console.log("");
  console.log(c.bold(`  ${title}`));
  if (subtitle) console.log(c.dim(`  ${subtitle}`));
  console.log(c.dim("  " + "─".repeat(68)));
  console.log("");
}

/** Run a command, inheriting stdio so the recording shows it live. */
function run(cmd, args, env = {}) {
  return new Promise((res) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    p.on("exit", (code) => res(code ?? 1));
  });
}

// --- check -----------------------------------------------------------------

async function check() {
  banner("Preflight", "Spends nothing. Confirms the run will not fail halfway.");
  const need = [
    ["FOXIT_CLIENT_ID", "Foxit PDF Services + eSign"],
    ["FOXIT_CLIENT_SECRET", "Foxit PDF Services + eSign"],
    ["NUTRIENT_API_KEY", "DWS Processor — /build redaction"],
    ["NUTRIENT_DWS_EXTRACTION_API_KEY", "DWS Data Extraction — /extract, /parse"],
  ];
  let ok = true;
  for (const [k, what] of need) {
    const present = Boolean(process.env[k]);
    if (!present) ok = false;
    console.log(
      `  ${present ? c.green("✓") : c.red("✗")} ${k.padEnd(34)} ${c.dim(what)}`,
    );
  }
  console.log("");
  if (!ok) {
    console.log(c.yellow("  Missing credentials. `set -a; source .env; set +a` then retry."));
    console.log(c.dim("  Foxit-only rehearsal (no Nutrient calls): NO_NUTRIENT=1"));
    process.exit(1);
  }
  console.log(c.dim(`  Journal: ${JOURNAL}`));
  console.log(c.dim("  A full `gate` run costs 3 Nutrient credits + 2 extraction calls."));
  console.log("");
  console.log(c.green("  Ready."));
}

// --- reset -----------------------------------------------------------------

async function reset() {
  banner("Reset", "Removes state from earlier takes so a retake starts clean.");
  for (const f of [JOURNAL, AUDIT, TOKENMAP]) {
    if (existsSync(f)) {
      unlinkSync(f);
      console.log(`  removed ${c.dim(f)}`);
    }
  }
  console.log("");
  console.log(c.green("  Clean. The next run starts from an empty journal."));
}

// --- gate ------------------------------------------------------------------

async function gate() {
  banner(
    "Beat: prompt → gate",
    "Everything here is reversible. It stops before the one step that is not.",
  );
  console.log(c.cyan(`  $ node agent/esign-agent-loop.mjs --doc messy \\`));
  console.log(c.cyan(`      --prompt "${PROMPT}"`));
  console.log("");
  const code = await run(
    "node",
    [
      "agent/esign-agent-loop.mjs",
      "--doc", "messy",
      "--prompt", PROMPT,
      "--recipient", process.env.DEMO_RECIPIENT ?? "Alice Smith <alice@example.com>",
    ],
    { ESIGN_JOURNAL_PATH: JOURNAL },
  );
  console.log("");
  console.log(
    code === 0
      ? c.dim("  Waiting at the gate. Open the approval URL above; nothing has been sent.")
      : c.yellow(`  Exited ${code} — see the line above for why. Nothing was sent.`),
  );
}

// --- vin -------------------------------------------------------------------

async function vin() {
  banner(
    "Beat: the VIN",
    "Two redaction calls. Both return HTTP 200. One of them does nothing.",
  );
  const { assemblePdf } = await import("../mcp/foxit/pdf-assembly.mjs");
  const { applyRedactions } = await import("../mcp/nutrient/redaction-adapter.mjs");
  const { parseDocumentText } = await import("../mcp/nutrient/pipeline-redaction.mjs");
  const { INVOICE } = await import("../mcp/fixtures/invoice-data.mjs");

  const VIN = INVOICE.shipment.tractorVin;
  const payload = {
    folderName: "Freight Invoice",
    recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }],
  };
  console.log(c.dim(`  Assembling a document containing VIN ${VIN} …`));
  const assembled = await assemblePdf(payload, {});
  const original = new Uint8Array(Buffer.from(assembled.base64, "base64"));
  console.log(c.dim(`  ${original.length} bytes.\n`));

  const cases = [
    ['preset: "vin"', [{ strategy: "preset", preset: "vin" }]],
    ['regex: "[A-HJ-NPR-Z0-9]{17}"', [{ strategy: "regex", regex: "[A-HJ-NPR-Z0-9]{17}" }]],
  ];

  console.log(`  ${"Target".padEnd(30)} ${"HTTP".padEnd(6)} ${"Bytes".padEnd(8)} VIN after apply`);
  console.log(c.dim(`  ${"─".repeat(30)} ${"─".repeat(6)} ${"─".repeat(8)} ${"─".repeat(16)}`));
  for (const [label, targets] of cases) {
    const r = await applyRedactions(original, targets, { fileName: "invoice.pdf" });
    if (!r.ok) {
      console.log(`  ${label.padEnd(30)} ${String(r.status).padEnd(6)} ${"—".padEnd(8)} ${c.red("call failed")}`);
      continue;
    }
    const parsed = await parseDocumentText(r.bytes);
    const present = parsed.ok && parsed.text.includes(VIN);
    console.log(
      `  ${label.padEnd(30)} ${c.green("200").padEnd(15)} ${String(r.bytes.length).padEnd(8)} ` +
        (present ? c.red("still present") : c.green("removed")),
    );
  }
  console.log("");
  console.log(c.dim("  Both succeeded. Both returned a PDF that opens. The only difference"));
  console.log(c.dim("  a caller can see is a byte count — which is not a signal anyone"));
  console.log(c.dim("  thresholds on. This is why the pipeline reads the document back."));
}

// --- crash -----------------------------------------------------------------

async function crash() {
  banner(
    "Beat: crash without double-send",
    "The process dies in the dangerous window. Restart decides what happened.",
  );
  console.log(c.dim("  Run 1 — SIGKILL after the journal fsync, before the gateway call."));
  console.log(c.cyan("  $ NO_UNDO_CRASH_AFTER_FSYNC=1 node agent/esign-agent-loop.mjs …"));
  console.log("");
  await run(
    "node",
    [
      "agent/esign-agent-loop.mjs",
      "--auto-approve", "--doc", "messy", "--prompt", PROMPT,
      "--recipient", process.env.DEMO_RECIPIENT ?? "Alice Smith <alice@example.com>",
    ],
    { ESIGN_JOURNAL_PATH: JOURNAL, NO_UNDO_CRASH_AFTER_FSYNC: "1" },
  );
  console.log("");
  console.log(c.dim("  The plan is journalled as `executing` and the process is gone."));
  console.log(c.dim("  Nothing knows yet whether the send landed. Restarting.\n"));
  console.log(c.cyan("  $ node agent/esign-agent-loop.mjs …   # same command, no crash flag"));
  console.log("");
  await run(
    "node",
    [
      "agent/esign-agent-loop.mjs",
      "--auto-approve", "--doc", "messy", "--prompt", PROMPT,
      "--recipient", process.env.DEMO_RECIPIENT ?? "Alice Smith <alice@example.com>",
    ],
    { ESIGN_JOURNAL_PATH: JOURNAL },
  );
  console.log("");
  console.log(c.dim("  Recovery asked the system of record the only question that matters:"));
  console.log(c.dim("  folderStatus DRAFT (never sent → safe to retry) or SHARED (already"));
  console.log(c.dim("  sent → record it, do not send again)."));
}

// --- audit -----------------------------------------------------------------

async function audit() {
  banner("Beat: the audit trail", "Hash-chained, fsync'd, and it names the tampered line.");
  const { verifyAuditChain } = await import("../mcp/lib/jsonl-audit-sink.mjs");
  if (!existsSync(AUDIT)) {
    console.log(c.yellow(`  No audit file yet at ${AUDIT}`));
    console.log(c.dim("  Run `node scripts/demo.mjs gate` or `crash` first."));
    return;
  }
  const lines = readFileSync(AUDIT, "utf8").trim().split("\n").filter(Boolean);
  console.log(c.dim(`  ${lines.length} records in ${AUDIT}\n`));
  for (const l of lines.slice(-6)) {
    const r = JSON.parse(l);
    console.log(`  ${String(r.status).padEnd(18)} ${c.dim(r.planToken.slice(0, 12) + "…")}  ${c.dim(r.hash.slice(0, 12) + "…")}`);
  }
  console.log("");
  // verifyAuditChain streams the file and returns a Promise; the broken index
  // is `brokenAt`. Getting either wrong makes a valid chain look tampered.
  const before = await verifyAuditChain(AUDIT);
  console.log(`  verifyAuditChain: ${before.ok ? c.green(`intact (${before.lines} records)`) : c.red("BROKEN at record " + before.brokenAt)}`);

  // Tamper with a copy, not the real trail.
  const copy = AUDIT + ".tampered";
  const tampered = lines.slice();
  const victim = Math.max(0, tampered.length - 3);
  const rec = JSON.parse(tampered[victim]);
  rec.status = "executed"; // the lie an operator would want to tell
  tampered[victim] = JSON.stringify(rec);
  writeFileSync(copy, tampered.join("\n") + "\n");
  console.log(c.dim(`\n  Editing record ${victim + 1} in a copy: status → "executed".`));
  const after = await verifyAuditChain(copy);
  console.log(
    `  verifyAuditChain: ${after.ok ? c.red("intact — tamper NOT detected") : c.green("BROKEN at record " + (after.brokenAt + 1) + " — " + after.reason)}`,
  );
  unlinkSync(copy);
  console.log("");
  console.log(c.dim("  Each record carries the previous record's hash, so editing one"));
  console.log(c.dim("  invalidates every record after it. The log cannot be quietly revised."));
}

// --- main ------------------------------------------------------------------

const beats = { check, reset, gate, vin, crash, audit };
const which = process.argv[2];
if (!which || !beats[which]) {
  console.log("");
  console.log(c.bold("  No Undo — demo driver"));
  console.log("");
  for (const [name, desc] of [
    ["check", "credentials + preflight, spends nothing"],
    ["reset", "fresh journal, no state from earlier takes"],
    ["gate", "prompt → assembly → extraction → redaction → verify → gate"],
    ["vin", "the VIN finding, live, side by side"],
    ["crash", "crash mid-send, restart, reconcile — exactly once"],
    ["audit", "hash-chained audit trail + tamper detection"],
  ]) {
    console.log(`    ${c.cyan("node scripts/demo.mjs " + name.padEnd(6))}  ${c.dim(desc)}`);
  }
  console.log("");
  process.exit(which ? 1 : 0);
}
await beats[which]();
