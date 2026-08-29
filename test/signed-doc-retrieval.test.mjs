/**
 * Tests for signed-document retrieval (Aug 29-30 C).
 * Replays fixtures — does NOT call the live API.
 * Covers: EXECUTED vs SHARED semantics, pollUntilSigned, download routes, poll-state durability.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync, mkdirSync, existsSync, readFileSync as rfs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let originalFetch;
const GATEWAY = "https://na1.fusion.foxit.com";

function tmpJournal() {
  const dir = join(tmpdir(), `no-undo-signed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "test-journal.jsonl");
  return {
    path,
    dir,
    cleanup: () => {
      for (const f of [path, `${path}.tmp`, join(dir, ".token-map.json"), join(dir, ".token-map.json.tmp"), join(dir, ".webhook-dedup.json"), join(dir, ".webhook-dedup.json.tmp"), join(dir, ".poll-state.json"), join(dir, ".poll-state.json.tmp"), join(dir, "esign-audit.jsonl"), join(dir, "signed-99999.pdf")]) {
        try { unlinkSync(f); } catch {}
      }
      // Remove any signed-*.pdf inside dir
      try {
        const { readdirSync } = awaitImportSync();
      } catch {}
    },
  };
}
function awaitImportSync() { return null; }

beforeEach(() => {
  process.env.FOXIT_CLIENT_ID = "test-client-id";
  process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
  process.env.NO_FOXIT_MCP = "1";
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NO_FOXIT_MCP;
});

async function importAdapter() {
  return await import("../mcp/foxit/esign-adapter.mjs");
}

// Helper to stub fetch with a map of pathname+search -> handler
function stubFetch(handlers) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${u.pathname}${u.search}`;
    const method = init.method ?? "GET";
    const fullKey = `${method}:${key}`;
    // Try exact, then fallback to key only
    const h = handlers[fullKey] ?? handlers[key] ?? handlers[fullKey.split("?")[0]] ?? handlers[key.split("?")[0]];
    if (typeof h === "function") return h(url, init);
    if (h) {
      if (h.bytes) {
        return {
          ok: h.ok ?? true,
          status: h.status ?? 200,
          arrayBuffer: async () => h.bytes.buffer.slice(h.bytes.byteOffset, h.bytes.byteOffset + h.bytes.byteLength),
          text: async () => h.text ?? "",
        };
      }
      return {
        ok: h.ok ?? true,
        status: h.status ?? 200,
        text: async () => h.text ?? JSON.stringify(h.json ?? {}),
        json: async () => h.json,
        arrayBuffer: async () => new TextEncoder().encode(h.text ?? JSON.stringify(h.json ?? {})).buffer,
      };
    }
    return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({ error: "no fixture for " + fullKey }), arrayBuffer: async () => new Uint8Array().buffer };
  };
}

describe("signed-doc retrieval — EXECUTED vs SHARED semantics", () => {
  test("isExecutedStatus: only EXECUTED is terminal signed", async () => {
    const { isExecutedStatus, isSentStatus } = await importAdapter();
    assert.equal(isExecutedStatus("EXECUTED"), true);
    assert.equal(isExecutedStatus("SHARED"), false);
    assert.equal(isExecutedStatus("DRAFT"), false);
    assert.equal(isExecutedStatus(null), false);
    assert.equal(isExecutedStatus("EXECUTED "), false);
  });

  test("isSentStatus: EXECUTED and SHARED are both sent", async () => {
    const { isSentStatus } = await importAdapter();
    assert.equal(isSentStatus("EXECUTED"), true);
    assert.equal(isSentStatus("SHARED"), true);
    assert.equal(isSentStatus("DRAFT"), false);
    assert.equal(isSentStatus(null), false);
  });

  test("checkFolderStatus returns EXECUTED when gateway says so", async () => {
    stubFetch({
      "/esign/api/v1/folders/myfolder?folderId=99999": { ok: true, status: 200, json: { folder: { folderId: 99999, folderStatus: "EXECUTED" } } },
    });
    const { checkFolderStatus } = await importAdapter();
    const s = await checkFolderStatus("99999");
    assert.equal(s, "EXECUTED");
  });

  test("reconcile treats EXECUTED as done (idempotent, no double-send)", async () => {
    stubFetch({
      "/esign/api/v1/folders/myfolder?folderId=99999": { ok: true, status: 200, json: { folder: { folderId: 99999, folderStatus: "EXECUTED" } } },
      "/esign/api/v1/folders/createfolder": { ok: true, status: 200, json: { folder: { folderId: 99999, folderStatus: "DRAFT" } } },
    });
    const { createEsignStore, createEsignFolder, loadEsignStore, listExecutingPlans, beginEsignSend } = await importAdapter();
    const j = tmpJournal();
    try {
      const store1 = createEsignStore(j.path);
      const payload = { folderName: "reconcile-exec", recipients: [{ firstName: "A", lastName: "B", email: "a@b.com" }] };
      const { planToken } = await createEsignFolder(store1, payload);
      store1.approve(planToken);
      beginEsignSend(store1, planToken, payload);
      // Now simulate restart: loadEsignStore should reconcile EXECUTED as done
      // For this we need to change the stub before load
      stubFetch({
        "/esign/api/v1/folders/myfolder?folderId=99999": { ok: true, status: 200, json: { folder: { folderId: 99999, folderStatus: "EXECUTED" } } },
      });
      const store2 = await loadEsignStore(j.path);
      // After reconcile, the plan should NOT be in executing (it was settled as done)
      const stuck = listExecutingPlans(store2);
      assert.equal(stuck.length, 0, "EXECUTED should reconcile to done, not stuck");
    } finally {
      try { unlinkSync(j.path); } catch {}
      try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
      try { unlinkSync(join(j.dir, ".poll-state.json")); } catch {}
      try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
    }
  });

  test("confirmEsignFailed refuses when status is EXECUTED", async () => {
    stubFetch({
      "/esign/api/v1/folders/myfolder?folderId=99999": { ok: true, status: 200, json: { folder: { folderId: 99999, folderStatus: "EXECUTED" } } },
      "/esign/api/v1/folders/createfolder": { ok: true, status: 200, json: { folder: { folderId: 99999, folderStatus: "DRAFT" } } },
      "/esign/api/v1/folders/sendDraftFolder": { ok: true, status: 200, json: { result: "success" } },
    });
    const { createEsignStore, createEsignFolder, confirmEsignFailed } = await importAdapter();
    const j = tmpJournal();
    try {
      const store = createEsignStore(j.path);
      const payload = { folderName: "x", recipients: [{ firstName: "A", lastName: "B", email: "a@b.com" }] };
      const { planToken } = await createEsignFolder(store, payload);
      store.approve(planToken);
      // Simulate that plan is executing
      const { beginEsignSend } = await importAdapter();
      beginEsignSend(store, planToken, payload);
      const r = await confirmEsignFailed(store, planToken);
      assert.equal(r.ok, false);
      assert.match(r.error, /EXECUTED|SHARED/);
    } finally {
      try { unlinkSync(j.path); } catch {}
      try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
      try { unlinkSync(join(j.dir, ".poll-state.json")); } catch {}
      try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
    }
  });
});

describe("pollUntilSigned", () => {
  test("returns executed:true immediately when already EXECUTED", async () => {
    stubFetch({
      "/esign/api/v1/folders/myfolder?folderId=888": { ok: true, status: 200, json: { folder: { folderId: 888, folderStatus: "EXECUTED" } } },
    });
    const { pollUntilSigned, createEsignStore } = await importAdapter();
    const j = tmpJournal();
    try {
      createEsignStore(j.path); // init durable stores
      const r = await pollUntilSigned("888", { timeoutMs: 2000, intervalMs: 50 });
      assert.equal(r.executed, true);
      assert.equal(r.status, "EXECUTED");
      assert.equal(r.attempts, 1);
    } finally {
      try { unlinkSync(j.path); } catch {}
      try { unlinkSync(join(j.dir, ".poll-state.json")); } catch {}
      try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
      try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
    }
  });

  test("polls DRAFT -> SHARED -> EXECUTED across attempts", async () => {
    let calls = 0;
    const seq = ["DRAFT", "SHARED", "EXECUTED"];
    stubFetch({
      "/esign/api/v1/folders/myfolder?folderId=777": (url, init) => {
        const s = seq[Math.min(calls, seq.length - 1)];
        calls++;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ folder: { folderId: 777, folderStatus: s } }),
          json: async () => ({ folder: { folderId: 777, folderStatus: s } }),
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ folder: { folderId: 777, folderStatus: s } })).buffer,
        });
      },
    });
    const { pollUntilSigned, createEsignStore } = await importAdapter();
    const j = tmpJournal();
    try {
      createEsignStore(j.path);
      const r = await pollUntilSigned("777", { timeoutMs: 5000, intervalMs: 20 });
      assert.equal(r.executed, true);
      assert.equal(r.status, "EXECUTED");
      assert.ok(r.attempts >= 3);
    } finally {
      try { unlinkSync(j.path); } catch {}
      try { unlinkSync(join(j.dir, ".poll-state.json")); } catch {}
      try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
      try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
    }
  });

  test("times out when never reaching EXECUTED (returns last status, executed:false)", async () => {
    stubFetch({
      "/esign/api/v1/folders/myfolder?folderId=666": { ok: true, status: 200, json: { folder: { folderId: 666, folderStatus: "SHARED" } } },
    });
    const { pollUntilSigned, createEsignStore } = await importAdapter();
    const j = tmpJournal();
    try {
      createEsignStore(j.path);
      const r = await pollUntilSigned("666", { timeoutMs: 120, intervalMs: 20 });
      assert.equal(r.executed, false);
      assert.equal(r.status, "SHARED");
      assert.ok(r.attempts >= 2);
    } finally {
      try { unlinkSync(j.path); } catch {}
      try { unlinkSync(join(j.dir, ".poll-state.json")); } catch {}
      try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
      try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
    }
  });

  test("tolerates transport errors and keeps polling until EXECUTED", async () => {
    let calls = 0;
    stubFetch({
      "/esign/api/v1/folders/myfolder?folderId=555": (url, init) => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({ ok: false, status: 0, text: async () => "ECONNRESET", json: async () => ({}), arrayBuffer: async () => new Uint8Array().buffer });
        }
        return Promise.resolve({
          ok: true, status: 200,
          text: async () => JSON.stringify({ folder: { folderId: 555, folderStatus: "EXECUTED" } }),
          json: async () => ({ folder: { folderId: 555, folderStatus: "EXECUTED" } }),
          arrayBuffer: async () => new Uint8Array().buffer,
        });
      },
    });
    const { pollUntilSigned, createEsignStore } = await importAdapter();
    const j = tmpJournal();
    try {
      createEsignStore(j.path);
      const r = await pollUntilSigned("555", { timeoutMs: 2000, intervalMs: 20 });
      assert.equal(r.executed, true);
      assert.ok(calls >= 2);
    } finally {
      try { unlinkSync(j.path); } catch {}
      try { unlinkSync(join(j.dir, ".poll-state.json")); } catch {}
      try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
      try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
    }
  });

  test("persists poll state durably (.poll-state.json) and getPollState reads it", async () => {
    stubFetch({
      "/esign/api/v1/folders/myfolder?folderId=444": { ok: true, status: 200, json: { folder: { folderId: 444, folderStatus: "EXECUTED" } } },
    });
    const { pollUntilSigned, getPollState, createEsignStore } = await importAdapter();
    const j = tmpJournal();
    try {
      createEsignStore(j.path);
      await pollUntilSigned("444", { timeoutMs: 1000, intervalMs: 20 });
      const ps = getPollState("444");
      assert.ok(ps);
      assert.equal(ps.status, "EXECUTED");
      assert.ok(ps.updatedAt);
      // Verify file exists on disk
      const raw = JSON.parse(readFileSync(join(j.dir, ".poll-state.json"), "utf8"));
      assert.ok(raw["444"]);
      assert.equal(raw["444"].status, "EXECUTED");
    } finally {
      try { unlinkSync(j.path); } catch {}
      try { unlinkSync(join(j.dir, ".poll-state.json")); } catch {}
      try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
      try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
    }
  });
});

describe("downloadSignedDocument", () => {
  test("single-document route: hits /document/download?folderId=&docNumber=", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 signed");
    let capturedUrl = "";
    globalThis.fetch = async (url, init = {}) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, arrayBuffer: async () => pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) };
    };
    const { downloadSingleDocument } = await importAdapter();
    const r = await downloadSingleDocument("12345", 0);
    assert.ok(r.ok);
    assert.equal(r.status, 200);
    assert.ok(r.bytes);
    assert.equal(new TextDecoder().decode(r.bytes), "%PDF-1.4 signed");
    assert.match(capturedUrl, /\/document\/download\?folderId=12345&docNumber=0/);
  });

  test("envelope route: hits /download?folderId= without docNumber", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 envelope");
    let capturedUrl = "";
    globalThis.fetch = async (url, init = {}) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, arrayBuffer: async () => pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) };
    };
    const { downloadEnvelope } = await importAdapter();
    const r = await downloadEnvelope("99999");
    assert.ok(r.ok);
    assert.match(capturedUrl, /\/download\?folderId=99999/);
    assert.doesNotMatch(capturedUrl, /docNumber/);
  });

  test("returns transportError on network failure", async () => {
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    const { downloadSignedDocument } = await importAdapter();
    const r = await downloadSignedDocument("123", { docNumber: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.transportError, true);
  });

  test("returns ok:false with status on HTTP error", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => "Forbidden", arrayBuffer: async () => new Uint8Array().buffer });
    const { downloadSignedDocument } = await importAdapter();
    const r = await downloadSignedDocument("123", { docNumber: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.transportError, false);
  });

  test("downloadSignedDocument without docNumber hits envelope route", async () => {
    let url = "";
    globalThis.fetch = async (u) => {
      url = String(u);
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };
    const { downloadSignedDocument } = await importAdapter();
    await downloadSignedDocument("abc");
    assert.match(url, /\/download\?folderId=abc/);
  });
});

describe("pollUntilSigned — deadline adherence", () => {
  test("poll does not overrun caller timeout by awaiting a stalled 30s request", async () => {
    // Simulate a stalled gateway: fetch would hang for 2s but poll timeout is 150ms.
    // The adapter bounds the request's AbortSignal to the remaining poll budget,
    // so fetch aborts promptly instead of overrunning by 30s. Mock respects signal.
    globalThis.fetch = async (url, init = {}) => {
      const signal = init.signal;
      // Race the 2s stall against signal abort
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 2000);
        if (signal) {
          if (signal.aborted) { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); return; }
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); }, { once: true });
        }
      });
      return { ok: true, status: 200, text: async () => JSON.stringify({ folder: { folderStatus: "SHARED" } }), json: async () => ({ folder: { folderStatus: "SHARED" } }), arrayBuffer: async () => new Uint8Array().buffer };
    };
    const { pollUntilSigned, createEsignStore } = await importAdapter();
    const j = tmpJournal();
    try {
      createEsignStore(j.path);
      const started = Date.now();
      const r = await pollUntilSigned("deadline-test", { timeoutMs: 150, intervalMs: 20 });
      const elapsed = Date.now() - started;
      assert.equal(r.executed, false);
      // Should return within ~400ms, not 2s+. Allow generous 600ms ceiling.
      assert.ok(elapsed < 600, `elapsed ${elapsed}ms exceeds bound — request overran poll timeout`);
    } finally {
      try { unlinkSync(j.path); } catch {}
      try { unlinkSync(join(j.dir, ".poll-state.json")); } catch {}
      try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
      try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
    }
  });
});

describe("audit note: SHARED vs EXECUTED", () => {
  test("SHARED does NOT mean signed — poll must continue", async () => {
    stubFetch({
      "/esign/api/v1/folders/myfolder?folderId=111": { ok: true, status: 200, json: { folder: { folderId: 111, folderStatus: "SHARED" } } },
    });
    const { pollUntilSigned, createEsignStore } = await importAdapter();
    const j = tmpJournal();
    try {
      createEsignStore(j.path);
      const r = await pollUntilSigned("111", { timeoutMs: 80, intervalMs: 20 });
      assert.equal(r.executed, false, "SHARED must not be treated as EXECUTED");
      assert.equal(r.status, "SHARED");
    } finally {
      try { unlinkSync(j.path); } catch {}
      try { unlinkSync(join(j.dir, ".poll-state.json")); } catch {}
      try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
      try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
    }
  });
});
