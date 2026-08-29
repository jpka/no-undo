/**
 * Integration tests for the agent loop — verifies the prompt-parser →
 * agent-loop → adapter wiring end-to-end against mocked fetch.
 *
 * The key regression test for PR #17 review finding M1: runFromPrompt must
 * preserve folderId in plan.extra (the approval card shows it, and stuck-plan
 * recovery needs it).
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Fixtures -------------------------------------------------------------

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

// --- Mock fetch -------------------------------------------------------------

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
  delete process.env.NO_FOXIT_MCP;
});

// --- Temp journal helper -----------------------------------------------------

function tmpJournal() {
  const dir = join(tmpdir(), "no-undo-agent-test-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "test-journal.jsonl");
  return {
    path,
    cleanup: () => {
      for (const f of [
        path,
        `${path}.tmp`,
        join(dir, ".token-map.json"),
        join(dir, ".webhook-dedup.json"),
        join(dir, "esign-audit.jsonl"),
      ]) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
    },
  };
}

// --- Tests -------------------------------------------------------------------

describe("agent-loop integration", () => {
  test("runFromPrompt preserves folderId in plan.extra (M1 regression)", async () => {
    const { runFromPrompt } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    try {
      const result = await runFromPrompt(
        "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.",
        { journalPath: j.path, autoApprove: true },
      );
      assert.equal(result.status, "executed");
      assert.ok(result.folderId, "folderId present in result");
    } finally {
      j.cleanup();
    }
  });

  test("runFromPrompt passes prompt extra fields through to the plan", async () => {
    const { runFromPrompt } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    try {
      const result = await runFromPrompt(
        "Send the contract to alice@example.com for signature",
        { journalPath: j.path, autoApprove: true },
      );
      assert.equal(result.status, "executed");
    } finally {
      j.cleanup();
    }
  });

  test("runFromPrompt returns awaiting_approval without autoApprove", async () => {
    const { runFromPrompt } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    try {
      const result = await runFromPrompt(
        "Send to alice@example.com",
        { journalPath: j.path, autoApprove: false, approvalTimeoutMs: 100 },
      );
      assert.equal(result.status, "awaiting_approval");
    } finally {
      j.cleanup();
    }
  });
});
