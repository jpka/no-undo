/**
 * Regression tests for gh #43 — gateway returns HTTP 200 with error body.
 *
 * Two invariants:
 *  1. sendDraftFolder must treat {result:"error"} as failure, not success.
 *  2. agent loop must verify folderStatus before claiming executed — a 200+ok
 *     that did not flip the folder to SHARED must NOT reach "executed".
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const fixtures = new Map();
function defaultFixtures() {
  fixtures.clear();
  fixtures.set("GET:/esign/api/v1/folders/myfolder?folderId=35426627", {
    ok: true,
    status: 200,
    json: { result: "success", folder: { folderId: 35426627, folderName: "test", folderStatus: "DRAFT" } },
  });
  fixtures.set("POST:/esign/api/v1/folders/createfolder", {
    ok: true,
    status: 200,
    json: { folder: { folderId: 35426627, folderName: "test", folderStatus: "DRAFT" } },
  });
  fixtures.set("POST:/esign/api/v1/folders/sendDraftFolder", {
    ok: true,
    status: 200,
    json: { result: "success" },
  });
}

let originalFetch;
beforeEach(() => {
  process.env.FOXIT_CLIENT_ID = "test-client-id";
  process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
  process.env.NO_FOXIT_MCP = "1";
  defaultFixtures();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"}:${u.pathname}${u.search}`;
    const fixture = fixtures.get(key);
    if (fixture) {
      const headers = fixture.headers ?? {};
      return {
        ok: fixture.ok,
        status: fixture.status,
        headers: {
          get: (name) => headers[name.toLowerCase()] ?? (fixture.contentType ? fixture.contentType : null),
        },
        text: async () => fixture.text ?? JSON.stringify(fixture.json),
        json: async () => fixture.json,
        arrayBuffer: async () => {
          if (fixture.bytes) return fixture.bytes.buffer.slice(fixture.bytes.byteOffset, fixture.bytes.byteOffset + fixture.bytes.byteLength);
          const t = fixture.text ?? JSON.stringify(fixture.json ?? "");
          return new TextEncoder().encode(t).buffer;
        },
      };
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => "Not Found",
      json: async () => ({ error: "no fixture for " + key }),
      arrayBuffer: async () => new TextEncoder().encode("Not Found").buffer,
    };
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NO_FOXIT_MCP;
});

function tmpJournal() {
  const dir = join(tmpdir(), "no-undo-43-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "test-journal.jsonl");
  return {
    path,
    dir,
    cleanup: () => {
      for (const f of [path, `${path}.tmp`, join(dir, ".token-map.json"), join(dir, ".webhook-dedup.json"), join(dir, ".poll-state.json"), join(dir, "esign-audit.jsonl")]) {
        try { unlinkSync(f); } catch {}
      }
      try { unlinkSync(join(dir, `.token-map.json.tmp`)); } catch {}
    },
  };
}

async function importAdapter() {
  return await import("../mcp/foxit/esign-adapter.mjs");
}

describe("gh #43: HTTP 200 + error body must not be treated as success", () => {
  test("sendDraftFolder treats HTTP 200 with {result:error} as failure", async () => {
    const { sendDraftFolder } = await importAdapter();

    // Fixture that mirrors the real gateway quirk proven in docs/fixtures
    fixtures.set("POST:/esign/api/v1/folders/sendDraftFolder", {
      ok: true,
      status: 200,
      json: { result: "error", error_description: "folderId parameter must be required." },
    });

    const r = await sendDraftFolder("35426627");
    assert.equal(r.ok, false, "must be not-ok despite HTTP 200");
    assert.equal(r.gatewayError, true);
    assert.match(r.errorDescription ?? "", /folderId parameter must be required/);
    assert.equal(r.status, 200);
    // r.json must be surfaced so caller can log why
    assert.equal(r.json.result, "error");
  });

  test("sendDraftFolder still succeeds on well-formed 200 success", async () => {
    const { sendDraftFolder } = await importAdapter();
    // default fixture is success
    const r = await sendDraftFolder("35426627");
    assert.equal(r.ok, true);
    assert.equal(r.gatewayError, false);
  });

  test("checkFolderStatus returns null on 200+error body (not DRAFT)", async () => {
    const { checkFolderStatus } = await importAdapter();
    fixtures.set("GET:/esign/api/v1/folders/myfolder?folderId=99999", {
      ok: true,
      status: 200,
      json: { result: "error", error_description: "folder not found" },
    });
    const s = await checkFolderStatus("99999");
    assert.equal(s, null, "gateway error must be treated as unknown, not as a folderStatus string");
  });

  test("downloadSignedDocument treats 200+error JSON as failure, not a PDF", async () => {
    const { downloadSignedDocument } = await importAdapter();
    // Simulate gateway returning JSON error as PDF download (mis-signalled)
    // The adapter decodes small JSON bodies even without content-type.
    // We add a direct fetch override for this folder's download URL.
    const downloadKey = "GET:/esign/api/v1/folders/download?folderId=35426627";
    // Patch fetch to return JSON error for the download URL specifically
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.pathname === "/esign/api/v1/folders/download") {
        return {
          ok: true,
          status: 200,
          headers: { get: (n) => n.toLowerCase() === "content-type" ? "application/json" : null },
          text: async () => JSON.stringify({ result: "error", error_description: "folder 35426627 is not executed yet." }),
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ result: "error", error_description: "folder 35426627 is not executed yet." })).buffer,
        };
      }
      return orig(url, init);
    };
    const r = await downloadSignedDocument("35426627");
    assert.equal(r.ok, false, "200+error JSON must be treated as download failure");
    assert.match(r.text ?? "", /not executed yet/);
  });

  test("agent loop does NOT reach executed when send returns 200+error body", async () => {
    const { runAgentLoop } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    try {
      // Create folder normally, but make sendDraftFolder return 200+error
      fixtures.set("POST:/esign/api/v1/folders/sendDraftFolder", {
        ok: true,
        status: 200,
        json: { result: "error", error_description: "simulated send refusal" },
      });
      // Also ensure folder stays DRAFT so confirmFailed will release correctly
      // (the adapter's confirmFailed checks folderStatus)
      // Default GET fixture already has DRAFT

      const result = await runAgentLoop({
        folderName: "p0-test-200-error",
        recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com", resolved: true }],
        journalPath: j.path,
        autoApprove: true,
        allowFixturePdf: true,
      });

      assert.notEqual(result.status, "executed", "200+error body must not audit executed");
      assert.ok(result.status === "failed" || result.status === "executing", `expected failed or executing, got ${result.status}`);
      // Also assert journal never recorded executed
      const journalLines = readFileSync(j.path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
      const hasExecuted = journalLines.some(r => r.status === "executed");
      assert.equal(hasExecuted, false, "journal must not contain executed after 200+error");
    } finally {
      j.cleanup();
    }
  });

  test("agent loop does NOT reach executed when send reports success but folderStatus stays DRAFT", async () => {
    const { runAgentLoop } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    try {
      // Send claims success
      fixtures.set("POST:/esign/api/v1/folders/sendDraftFolder", {
        ok: true,
        status: 200,
        json: { result: "success" },
      });
      // But folder status remains DRAFT (the real bug — 35637107)
      // We need a dynamic handler: after creation the folderId is 35426627,
      // the GET for that folder must return DRAFT even after send.
      // Our fixtures map already returns DRAFT for that folderId, so no change needed.
      // However the adapter's verification will call checkFolderStatus which hits
      // GET myfolder?folderId=35426627 — which is DRAFT in fixtures.

      const result = await runAgentLoop({
        folderName: "p0-test-draft-after-send",
        recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com", resolved: true }],
        journalPath: j.path,
        autoApprove: true,
        allowFixturePdf: true,
      });

      // Must NOT be executed — verified status was DRAFT, so agent should
      // route through confirmFailed to "failed", not "executed".
      assert.notEqual(result.status, "executed", "DRAFT after send must not audit executed");
      assert.ok(result.status === "failed" || result.status === "executing", `expected failed or executing, got ${result.status}`);
      if (result.status === "failed") {
        assert.equal(result.verifiedStatus, "DRAFT");
      }

      const journalLines = readFileSync(j.path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
      const hasExecuted = journalLines.some(r => r.status === "executed");
      assert.equal(hasExecuted, false, "journal must not contain executed when folder remained DRAFT");
    } finally {
      j.cleanup();
    }
  });

  test("agent loop DOES reach executed when send ok and folderStatus is SHARED (happy path still works)", async () => {
    const { runAgentLoop } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    try {
      fixtures.set("POST:/esign/api/v1/folders/sendDraftFolder", {
        ok: true,
        status: 200,
        json: { result: "success" },
      });

      // After send, folder becomes SHARED — we simulate that by making
      // checkFolderStatus return SHARED. Simplest: mutate the GET fixture
      // after creation? The runAgentLoop creates folder 35426627 then calls
      // send then checkFolderStatus. If we set the GET fixture to SHARED
      // before calling runAgentLoop, verification will see SHARED and succeed.
      fixtures.set("GET:/esign/api/v1/folders/myfolder?folderId=35426627", {
        ok: true,
        status: 200,
        json: { result: "success", folder: { folderId: 35426627, folderName: "test", folderStatus: "SHARED" } },
      });

      const result = await runAgentLoop({
        folderName: "p0-test-happy-shared",
        recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com", resolved: true }],
        journalPath: j.path,
        autoApprove: true,
        allowFixturePdf: true,
      });

      assert.equal(result.status, "executed", "SHARED verification must allow executed");
      assert.equal(result.verifiedStatus, "SHARED");
      const journalLines = readFileSync(j.path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
      const hasExecuted = journalLines.some(r => r.status === "executed");
      assert.equal(hasExecuted, true, "journal must contain executed on verified SHARED");
    } finally {
      j.cleanup();
    }
  });

  test("crash injection skipped when folder stays DRAFT (gh #43 — dangerous window only fires after SHARED verification)", async () => {
    // Regression: maybeCrashAfterSend must NOT fire before verification.
    // If it did, a 200-ok-that-didn't-send (folder stays DRAFT) would crash
    // the process and recovery would reconcile DRAFT → not-done → release,
    // exercising the safe window instead of the intended dangerous window.
    const j = tmpJournal();
    try {
      // Send claims success but folder stays DRAFT (the real gh #43 quirk).
      fixtures.set("POST:/esign/api/v1/folders/sendDraftFolder", {
        ok: true,
        status: 200,
        json: { result: "success" },
      });
      fixtures.set("GET:/esign/api/v1/folders/myfolder?folderId=35426627", {
        ok: true,
        status: 200,
        json: { result: "success", folder: { folderId: 35426627, folderName: "test", folderStatus: "DRAFT" } },
      });

      // Spy on process.kill to detect whether crash injection fired.
      let killCalled = false;
      const origKill = process.kill;
      process.kill = () => {
        killCalled = true;
        // Do NOT actually kill the test process — just record the call.
      };
      const origEnv = process.env.NO_UNDO_CRASH_AFTER_SEND;
      process.env.NO_UNDO_CRASH_AFTER_SEND = "1";

      try {
        const { runAgentLoop } = await import("../agent/esign-agent-loop.mjs");
        await runAgentLoop({
          folderName: "crash-guard-test",
          recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com", resolved: true }],
          journalPath: j.path,
          autoApprove: true,
          allowFixturePdf: true,
        });
      } finally {
        process.kill = origKill;
        if (origEnv === undefined) delete process.env.NO_UNDO_CRASH_AFTER_SEND;
        else process.env.NO_UNDO_CRASH_AFTER_SEND = origEnv;
      }

      // Must NOT have called kill — the crash injection must not have fired
      // because verification saw DRAFT, not SHARED.
      assert.equal(killCalled, false, "crash injection must not fire when folder stays DRAFT");
    } finally {
      j.cleanup();
    }
  });

  test("crash injection DOES fire when folder is SHARED (dangerous window confirmed)", async () => {
    // Complement: when verification confirms SHARED, the crash injection
    // must fire (the dangerous window — the demo's money shot).
    const j = tmpJournal();
    try {
      fixtures.set("POST:/esign/api/v1/folders/sendDraftFolder", {
        ok: true,
        status: 200,
        json: { result: "success" },
      });
      fixtures.set("GET:/esign/api/v1/folders/myfolder?folderId=35426627", {
        ok: true,
        status: 200,
        json: { result: "success", folder: { folderId: 35426627, folderName: "test", folderStatus: "SHARED" } },
      });

      let killCalled = false;
      const origKill = process.kill;
      process.kill = () => {
        killCalled = true;
      };
      const origEnv = process.env.NO_UNDO_CRASH_AFTER_SEND;
      process.env.NO_UNDO_CRASH_AFTER_SEND = "1";

      try {
        const { runAgentLoop } = await import("../agent/esign-agent-loop.mjs");
        await runAgentLoop({
          folderName: "crash-guard-shared",
          recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com", resolved: true }],
          journalPath: j.path,
          autoApprove: true,
          allowFixturePdf: true,
        });
      } finally {
        process.kill = origKill;
        if (origEnv === undefined) delete process.env.NO_UNDO_CRASH_AFTER_SEND;
        else process.env.NO_UNDO_CRASH_AFTER_SEND = origEnv;
      }

      assert.equal(killCalled, true, "crash injection must fire when folder is SHARED (dangerous window)");
    } finally {
      j.cleanup();
    }
  });
});
