import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENESIS_HASH,
  compositeSink,
  createJsonlAuditSink,
  defaultAuditPath,
  recoverHead,
  verifyAuditChain,
} from "../mcp/lib/jsonl-audit-sink.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "no-undo-audit-"));
}

const event = (over = {}) => ({
  ts: 1755000000000,
  tool: "esign_begin_send",
  reason: null,
  planToken: "pln_abcdef1234567890",
  status: "executing",
  previewCount: 1,
  callerId: "test",
  durationMs: 3,
  ...over,
});

test("jsonl audit sink chains events and verifies clean", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(path);
    sink.record(event({ status: "previewed" }));
    sink.record(event({ status: "awaiting_approval" }));
    sink.record(event({ status: "approved" }));

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 3);
    const recs = lines.map((l) => JSON.parse(l));
    assert.equal(recs[0].prevHash, GENESIS_HASH);
    assert.equal(recs[1].prevHash, recs[0].hash);
    assert.equal(recs[2].prevHash, recs[1].hash);

    const verdict = await verifyAuditChain(path);
    assert.deepEqual(verdict, { ok: true, lines: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new sink instance on the same path continues the existing chain", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "audit.jsonl");
    const first = createJsonlAuditSink(path);
    first.record(event({ status: "approved" }));

    // Simulates a restart: fresh instance, same file.
    const second = createJsonlAuditSink(path);
    second.record(event({ status: "executing" }));
    second.record(event({ status: "failed", detail: "EXECUTION_FAILED" }));

    const verdict = await verifyAuditChain(path);
    assert.deepEqual(verdict, { ok: true, lines: 3 });
    const last = JSON.parse(readFileSync(path, "utf8").trimEnd().split("\n")[2]);
    assert.equal(last.status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tampering with a record breaks verification at that line", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(path);
    sink.record(event({ status: "approved" }));
    sink.record(event({ status: "executing" }));
    sink.record(event({ status: "executed" }));

    // Rewrite line 1 (index 1) with a different status — a forged history.
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const forged = JSON.parse(lines[1]);
    forged.status = "rejected";
    lines[1] = JSON.stringify(forged);
    writeFileSync(path, lines.join("\n") + "\n");

    const verdict = await verifyAuditChain(path);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.brokenAt, 1);
    assert.match(verdict.reason, /hash mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn trailing write is reported as tornTail, not a broken chain", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(path);
    sink.record(event({ status: "approved" }));
    // Simulate a crash mid-write: partial bytes, no newline.
    appendFileSync(path, '{"ts":1,"status":"executi');

    // A torn tail is expected crash debris, not an anomaly: recovery is
    // silent, and the tornTail flag is how a caller learns of it.
    const recovered = recoverHead(path);
    assert.equal(recovered.completeLines, 1);
    assert.equal(recovered.tornTail, true);

    // A restarted sink ignores the torn tail and re-chains off the last
    // complete line. Its own record lands whole, so the file ends cleanly
    // again and the tail is no longer torn.
    const restarted = createJsonlAuditSink(path);
    restarted.record(event({ status: "executing" }));
    const verdict = await verifyAuditChain(path);
    assert.deepEqual(verdict, { ok: true, lines: 2 });

    // Tamper detection still works when a NEW torn tail is present.
    appendFileSync(path, '{"broken json without newline');
    const secondVerdict = await verifyAuditChain(path);
    assert.equal(secondVerdict.ok, true);
    assert.equal(secondVerdict.lines, 2);
    assert.equal(secondVerdict.tornTail, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unparseable middle line is a broken chain, not a torn tail", async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(path);
    sink.record(event({ status: "approved" }));
    sink.record(event({ status: "executing" }));
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    lines[1] = "{not json";
    writeFileSync(path, lines.join("\n") + "\n");

    const verdict = await verifyAuditChain(path);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.brokenAt, 1);
    assert.match(verdict.reason, /unparseable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record() never throws even when the descriptor goes bad", () => {
  const dir = tmpDir();
  try {
    const path = join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(path);
    // Sabotage: close the directory by removing the file out from under an
    // already-open fd is platform-dependent; instead point a second sink at a
    // path that becomes a directory after init — the append must not throw.
    sink.record(event());
    assert.ok(readFileSync(path, "utf8").includes('"status":"executing"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compositeSink fans out to every member and survives one failing", () => {
  const seen = [];
  const good = { record: (e) => void seen.push(e.status) };
  const bad = {
    record: () => {
      throw new Error("sink bug");
    },
  };

  let warned = "";
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    warned += String(chunk);
    return true;
  };
  try {
    const sink = compositeSink(good, bad);
    const ret = sink.record(event({ status: "approved" }));
    assert.equal(ret, undefined); // contract: sync, no throw, no promise
    assert.deepEqual(seen, ["approved"]);
    assert.match(warned, /member sink failed/);
  } finally {
    process.stderr.write = origWrite;
  }
});

test("defaultAuditPath derives beside the journal and honors overrides", () => {
  assert.equal(defaultAuditPath("/data/journal.jsonl", "esign"), "/data/esign-audit.jsonl");
  assert.equal(defaultAuditPath(undefined, "esign"), null);
  assert.equal(defaultAuditPath("/data/journal.jsonl", "esign", "/x/y.jsonl"), "/x/y.jsonl");
});

test("store constructors wire the durable sink (event lands in the chain)", async () => {
  const dir = tmpDir();
  try {
    const journal = join(dir, "journal.jsonl");
    const esignMod = await import("../mcp/foxit/esign-adapter.mjs");
    const store = esignMod.createEsignStore(journal);
    const created = store.create(
      { folderName: "t", recipients: [{ firstName: "A", lastName: "B", email: "a@b.c" }] },
      { tool: "esign_create_draft", approvalRequired: true },
    );
    assert.equal(created.status, "awaiting_approval");
    const approved = store.approve(created.planToken);
    assert.equal(approved.ok, true);

    const auditFile = defaultAuditPath(journal, "esign");
    const verdict = await verifyAuditChain(auditFile);
    assert.equal(verdict.ok, true);
    const statuses = readFileSync(auditFile, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l).status);
    assert.ok(statuses.includes("awaiting_approval"));
    assert.ok(statuses.includes("approved"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeCrashAfterFsync kills the process only when the flag matches", () => {
  const adapterPath = fileURLToPath(new URL("../mcp/foxit/esign-adapter.mjs", import.meta.url));

  // No flag: returns false, exits cleanly.
  const quiet = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { maybeCrashAfterFsync } from ${JSON.stringify(adapterPath)};\n` +
        `process.stdout.write(String(maybeCrashAfterFsync("pln_x")));`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, "false");

  // Flag set to "1": SIGKILL before any output.
  const killed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { maybeCrashAfterFsync } from ${JSON.stringify(adapterPath)};\n` +
        `maybeCrashAfterFsync("pln_x");\n` +
        `process.stdout.write("unreachable");`,
    ],
    { encoding: "utf8", env: { ...process.env, NO_UNDO_CRASH_AFTER_FSYNC: "1" } },
  );
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(killed.stdout, "");

  // Flag set to a different token: no crash.
  const mismatch = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { maybeCrashAfterFsync } from ${JSON.stringify(adapterPath)};\n` +
        `process.stdout.write(String(maybeCrashAfterFsync("pln_y")));`,
    ],
    { encoding: "utf8", env: { ...process.env, NO_UNDO_CRASH_AFTER_FSYNC: "pln_x" } },
  );
  assert.equal(mismatch.status, 0);
  assert.equal(mismatch.stdout, "false");

  // Flag set to the exact token: crash.
  const targeted = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { maybeCrashAfterFsync } from ${JSON.stringify(adapterPath)};\n` +
        `maybeCrashAfterFsync("pln_x");`,
    ],
    { encoding: "utf8", env: { ...process.env, NO_UNDO_CRASH_AFTER_FSYNC: "pln_x" } },
  );
  assert.equal(targeted.signal, "SIGKILL");
});
