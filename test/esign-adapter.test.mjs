/**
 * Tests for the Foxit eSign adapter.
 *
 * Replays Gate 0 fixtures — does NOT call the live API.
 * Mocks global.fetch to return fixture responses.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Fixtures ---------------------------------------------------------------
// The Gate 0 probe transcript (docs/fixtures/esign-probe-aug18.txt) is a
// plain text log. Key facts encoded below:
//   - createfolder(sendNow:false) → folder 35426627, status DRAFT
//   - GET myfolder?folderId=35426627 → folderStatus: DRAFT
//   - POST sendDraftFolder → 200

/** @type {Map<string, any>} */
const fixtures = new Map();

function addFixture(key, response) {
  fixtures.set(key, response);
}

function defaultFixtures() {
  fixtures.clear();
  addFixture("GET:/esign/api/v1/folders/myfolder?folderId=35426627", {
    ok: true,
    status: 200,
    json: { result: "success", folder: { folderId: 35426627, folderName: "test", folderStatus: "DRAFT" } },
  });
  addFixture("POST:/esign/api/v1/folders/createfolder", {
    ok: true,
    status: 200,
    json: { folder: { folderId: 35426627, folderName: "test", folderStatus: "DRAFT" } },
  });
  addFixture("POST:/esign/api/v1/folders/sendDraftFolder", {
    ok: true,
    status: 200,
    json: { result: "success" },
  });
}

// --- Mock fetch -------------------------------------------------------------

let originalFetch;

beforeEach(() => {
  defaultFixtures();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"}:${u.pathname}${u.search}`;
    const fixture = fixtures.get(key);
    if (fixture) {
      return {
        ok: fixture.ok,
        status: fixture.status,
        text: async () => fixture.text ?? JSON.stringify(fixture.json),
        json: async () => fixture.json,
      };
    }
    return {
      ok: false,
      status: 404,
      text: async () => "Not Found",
      json: async () => ({ error: "no fixture for " + key }),
    };
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- Temp journal helper ----------------------------------------------------

function tmpJournal() {
  const dir = join(tmpdir(), "no-undo-test-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "test-journal.jsonl");
  return {
    path,
    cleanup: () => {
      for (const f of [path, `${path}.tmp`, join(dir, ".token-map.json"), join(dir, ".webhook-dedup.json")]) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
    },
  };
}

// --- Import adapter after mocks are set -------------------------------------

async function importAdapter() {
  return await import("../mcp/foxit/esign-adapter.mjs");
}

// --- Tests ------------------------------------------------------------------

describe("esign-adapter", () => {
  test("createEsignFolder returns planToken and folderId", async () => {
    const { createEsignStore, createEsignFolder } = await importAdapter();
    const j = tmpJournal();
    try {
      const store = createEsignStore(j.path);
      const result = await createEsignFolder(store, {
        folderName: "test-folder",
        recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }],
      });
      assert.ok(result.planToken, "planToken present");
      assert.ok(result.folderId, "folderId present");
    } finally {
      j.cleanup();
    }
  });

  test("beginEsignSend requires approval", async () => {
    const { createEsignStore, createEsignFolder, beginEsignSend } = await importAdapter();
    const j = tmpJournal();
    try {
      const store = createEsignStore(j.path);
      const payload = {
        folderName: "test",
        recipients: [{ firstName: "Bob", lastName: "Jones", email: "bob@example.com" }],
      };
      const { planToken } = await createEsignFolder(store, payload);
      // Try to begin without approval — should fail
      const result = beginEsignSend(store, planToken, payload);
      assert.equal(result.ok, false);
      assert.match(result.error, /approval/i);
    } finally {
      j.cleanup();
    }
  });

  test("full lifecycle: create → approve → begin → confirm executed", async () => {
    const { createEsignStore, createEsignFolder, beginEsignSend, confirmEsignExecuted } =
      await importAdapter();
    const j = tmpJournal();
    try {
      const store = createEsignStore(j.path);
      const payload = {
        folderName: "full-lifecycle",
        recipients: [{ firstName: "Carol", lastName: "White", email: "carol@example.com" }],
      };
      const { planToken, folderId } = await createEsignFolder(store, payload);

      // Approve via store
      const approveResult = store.approve(planToken);
      assert.ok(approveResult.ok);

      // Begin execute
      const beginResult = beginEsignSend(store, planToken, payload);
      assert.ok(beginResult.ok, `begin failed: ${beginResult.error}`);

      // Simulate successful gateway send — folder is now SHARED
      fixtures.set(`GET:/esign/api/v1/folders/myfolder?folderId=${folderId}`, {
        ok: true,
        status: 200,
        json: { result: "success", folder: { folderId, folderStatus: "SHARED" } },
      });

      // Confirm executed
      const confirmResult = await confirmEsignExecuted(store, planToken);
      assert.ok(confirmResult.ok);
    } finally {
      j.cleanup();
    }
  });

  test("crash recovery: plan stuck in executing is recovered on loadEsignStore", async () => {
    const { createEsignStore, createEsignFolder, beginEsignSend, loadEsignStore, listExecutingPlans } =
      await importAdapter();
    const j = tmpJournal();
    try {
      // Step 1: create + approve + begin execute (plan is now "executing")
      const store1 = createEsignStore(j.path);
      const payload = {
        folderName: "crash-test",
        recipients: [{ firstName: "Dan", lastName: "Brown", email: "dan@example.com" }],
      };
      const { planToken, folderId } = await createEsignFolder(store1, payload);
      store1.approve(planToken);
      beginEsignSend(store1, planToken, payload);

      // Verify it's executing
      const executingBefore = listExecutingPlans(store1);
      assert.equal(executingBefore.length, 1);

      // Simulate gateway being unreachable — folder status is "unknown"
      // so the plan stays in "executing" after fromJournal's auto-reconcile
      fixtures.set(`GET:/esign/api/v1/folders/myfolder?folderId=${folderId}`, {
        ok: false,
        status: 0,
        text: "unreachable",
        json: undefined,
      });

      // Step 2: simulate crash — reload from journal
      const store2 = await loadEsignStore(j.path);
      const executingAfter = listExecutingPlans(store2);
      assert.equal(executingAfter.length, 1, "stuck plan recovered");
    } finally {
      j.cleanup();
    }
  });

  test("confirmFailed refuses when folder is SHARED (prevents double-send)", async () => {
    const { createEsignStore, createEsignFolder, beginEsignSend, confirmEsignFailed } =
      await importAdapter();
    const j = tmpJournal();
    try {
      const store = createEsignStore(j.path);
      const payload = {
        folderName: "double-send-prevent",
        recipients: [{ firstName: "Frank", lastName: "Miller", email: "frank@example.com" }],
      };
      const { planToken, folderId } = await createEsignFolder(store, payload);
      // Override fixture: folder is actually SHARED
      fixtures.set(`GET:/esign/api/v1/folders/myfolder?folderId=${folderId}`, {
        ok: true,
        status: 200,
        json: { result: "success", folder: { folderId, folderStatus: "SHARED" } },
      });
      store.approve(planToken);
      beginEsignSend(store, planToken, payload);

      // Try to confirmFailed — should refuse
      const result = await confirmEsignFailed(store, planToken, "network timeout");
      assert.equal(result.ok, false);
      assert.match(result.error, /SHARED/i);
    } finally {
      j.cleanup();
    }
  });

  test("webhook dedup: same event processed once", async () => {
    const { handleWebhookEvent } = await importAdapter();
    const j = tmpJournal();
    try {
      const { createEsignStore } = await importAdapter();
      createEsignStore(j.path);

      const first = handleWebhookEvent("35426627", "folder_sent");
      assert.equal(first, true, "first event is new");
      const second = handleWebhookEvent("35426627", "folder_sent");
      assert.equal(second, false, "duplicate event is rejected");
    } finally {
      j.cleanup();
    }
  });

  test("journal records transitions for replay", async () => {
    const { createEsignStore, createEsignFolder, beginEsignSend, confirmEsignExecuted } =
      await importAdapter();
    const j = tmpJournal();
    try {
      const store = createEsignStore(j.path);
      const payload = {
        folderName: "journal-test",
        recipients: [{ firstName: "Grace", lastName: "Lee", email: "grace@example.com" }],
      };
      const { planToken, folderId } = await createEsignFolder(store, payload);
      store.approve(planToken);
      beginEsignSend(store, planToken, payload);

      // Simulate successful gateway send — folder is now SHARED
      fixtures.set(`GET:/esign/api/v1/folders/myfolder?folderId=${folderId}`, {
        ok: true,
        status: 200,
        json: { result: "success", folder: { folderId, folderStatus: "SHARED" } },
      });

      await confirmEsignExecuted(store, planToken);

      // Read the journal file directly
      const lines = readFileSync(j.path, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      const records = lines.map((l) => JSON.parse(l));
      const statuses = records.map((r) => r.status);
      assert.ok(statuses.includes("awaiting_approval") || statuses.includes("previewed"));
      assert.ok(statuses.includes("approved"));
      assert.ok(statuses.includes("executing"));
      assert.ok(statuses.includes("executed"));
    } finally {
      j.cleanup();
    }
  });
});
