/**
 * Tests for Foxit PDF assembly (B: real Foxit PDF wiring).
 *
 * Covers:
 * - buildInvoiceHtml produces deterministic judge-legible HTML
 * - assemblePdf fixture seam (NO_FOXIT_MCP / missing creds / test stub)
 * - createEsignFolder wires the assembled bytes + SHA-256 into the gate
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Import assembly directly — fixture path, no network
import {
  buildInvoiceHtml,
  assemblePdf,
  TINY_PDF_BASE64,
  TINY_PDF_SHA256,
  sha256Base64,
} from "../mcp/foxit/pdf-assembly.mjs";

function tmpJournal() {
  const dir = join(tmpdir(), "no-undo-pdf-test-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "test-journal.jsonl");
  return {
    path,
    cleanup: () => {
      for (const f of [path, `${path}.tmp`, join(dir, ".token-map.json"), join(dir, ".webhook-dedup.json")]) {
        try { unlinkSync(f); } catch {}
      }
    },
  };
}

describe("pdf-assembly — buildInvoiceHtml", () => {
  test("includes folder name and recipients", () => {
    const html = buildInvoiceHtml({
      folderName: "Freight Invoice",
      recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }],
      instructions: "redact PII",
    });
    assert.match(html, /Freight Invoice/);
    assert.match(html, /alice@example\.com/);
    assert.match(html, /Alice Smith/);
    assert.match(html, /redact PII/);
    assert.match(html, /foxit/i);
  });

  test("escapes HTML injection", () => {
    const html = buildInvoiceHtml({
      folderName: '<script>alert("x")</script>',
      recipients: [{ firstName: "<b>Alice", lastName: "O'Neil", email: "alice@example.com" }],
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /O&#39;Neil/);
  });

  test("fallback title for empty folderName", () => {
    const html = buildInvoiceHtml({ folderName: "", recipients: [] });
    assert.match(html, /Document/);
  });
});

describe("pdf-assembly — assemblePdf fixture seam", () => {
  test("returns fixture when NO_FOXIT_MCP=1", async () => {
    const orig = process.env.NO_FOXIT_MCP;
    process.env.NO_FOXIT_MCP = "1";
    try {
      const res = await assemblePdf({ folderName: "Test", recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }] });
      assert.equal(res.via, "fixture");
      assert.equal(res.base64, TINY_PDF_BASE64);
      assert.equal(res.sha256, TINY_PDF_SHA256);
      assert.equal(res.sha256, sha256Base64(res.base64));
    } finally {
      if (orig === undefined) delete process.env.NO_FOXIT_MCP;
      else process.env.NO_FOXIT_MCP = orig;
    }
  });

  test("returns fixture for test stub credentials", async () => {
    const origId = process.env.FOXIT_CLIENT_ID;
    const origSecret = process.env.FOXIT_CLIENT_SECRET;
    process.env.FOXIT_CLIENT_ID = "test-client-id";
    process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
    delete process.env.NO_FOXIT_MCP;
    try {
      const res = await assemblePdf({ folderName: "Stub Test", recipients: [{ firstName: "Bob", lastName: "Jones", email: "bob@example.com" }] });
      assert.equal(res.via, "fixture");
      assert.equal(res.base64, TINY_PDF_BASE64);
    } finally {
      if (origId === undefined) delete process.env.FOXIT_CLIENT_ID;
      else process.env.FOXIT_CLIENT_ID = origId;
      if (origSecret === undefined) delete process.env.FOXIT_CLIENT_SECRET;
      else process.env.FOXIT_CLIENT_SECRET = origSecret;
    }
  });

  test("sha256 helper matches crypto", () => {
    const bytes = Buffer.from("hello world");
    const base64 = bytes.toString("base64");
    const expected = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256Base64(base64), expected);
  });

  test("TINY_PDF_SHA256 is correct", () => {
    assert.equal(TINY_PDF_SHA256, sha256Base64(TINY_PDF_BASE64));
    assert.equal(TINY_PDF_SHA256.length, 64);
  });
});

describe("esign-adapter — wired PDF assembly via createEsignFolder", () => {
  let originalFetch;
  let originalEnv;

  // Preserve env
  function saveEnv() {
    originalEnv = { ...process.env };
  }
  function restoreEnv() {
    process.env = originalEnv;
  }

  // Minimal fixture map mirroring esign-adapter.test.mjs
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

  async function importAdapter() {
    return await import("../mcp/foxit/esign-adapter.mjs");
  }

  test("extra.documentSha256 matches the bytes actually sent (fixture path)", async () => {
    saveEnv();
    process.env.FOXIT_CLIENT_ID = "test-client-id";
    process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
    defaultFixtures();
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const key = `${init.method ?? "GET"}:${u.pathname}${u.search}`;
      const fixture = fixtures.get(key);
      // Capture createfolder body to verify base64FileString
      if (key === "POST:/esign/api/v1/folders/createfolder") {
        const body = JSON.parse(init.body);
        // The wiring must send the assembled PDF, not an empty array
        assert.ok(Array.isArray(body.base64FileString));
        assert.equal(body.base64FileString.length, 1);
        assert.equal(body.base64FileString[0], TINY_PDF_BASE64);
      }
      if (fixture) {
        return {
          ok: fixture.ok,
          status: fixture.status,
          text: async () => fixture.text ?? JSON.stringify(fixture.json),
          json: async () => fixture.json,
        };
      }
      return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    };

    try {
      const { createEsignStore, createEsignFolder } = await importAdapter();
      const j = tmpJournal();
      try {
        const store = createEsignStore(j.path);
        const payload = {
          folderName: "assembly-wired-test",
          recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }],
        };
        const result = await createEsignFolder(store, payload);
        assert.ok(result.planToken);

        // Verify the plan's extra carries the SHA-256 digest
        const pending = store.listPending().find((p) => p.planToken === result.planToken);
        assert.ok(pending, "plan should be pending");
        assert.equal(pending.extra.documentSha256, TINY_PDF_SHA256);
        assert.equal(pending.extra.documentVia, "fixture");
        assert.equal(pending.extra.folderId, 35426627);
      } finally {
        j.cleanup();
      }
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  test("injected assemblePdf (foxit-mcp) wires its bytes + sha into the plan and request", async () => {
    saveEnv();
    process.env.FOXIT_CLIENT_ID = "test-client-id";
    process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
    defaultFixtures();
    // A deterministic fake PDF (not the tiny fixture) to prove wiring
    const fakeBytes = Buffer.from("%PDF-1.4 fake content for test");
    const fakeBase64 = fakeBytes.toString("base64");
    const fakeSha = createHash("sha256").update(fakeBytes).digest("hex");
    const fakeHtml = "<html>fake</html>";

    let capturedBody = null;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const key = `${init.method ?? "GET"}:${u.pathname}${u.search}`;
      const fixture = fixtures.get(key);
      if (key === "POST:/esign/api/v1/folders/createfolder") {
        capturedBody = JSON.parse(init.body);
      }
      if (fixture) {
        return {
          ok: fixture.ok,
          status: fixture.status,
          text: async () => fixture.text ?? JSON.stringify(fixture.json),
          json: async () => fixture.json,
        };
      }
      return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    };

    try {
      const { createEsignStore, createEsignFolder } = await importAdapter();
      const j = tmpJournal();
      try {
        const store = createEsignStore(j.path);
        const payload = {
          folderName: "foxit-mcp-wired",
          recipients: [{ firstName: "Carol", lastName: "White", email: "carol@example.com" }],
        };
        const fakeAssemble = async () => ({
          base64: fakeBase64,
          sha256: fakeSha,
          html: fakeHtml,
          via: "foxit-mcp",
        });

        const result = await createEsignFolder(store, payload, { assemblePdf: fakeAssemble });

        assert.ok(result.planToken);
        assert.ok(capturedBody);
        assert.equal(capturedBody.base64FileString[0], fakeBase64);

        const pending = store.listPending().find((p) => p.planToken === result.planToken);
        assert.ok(pending);
        assert.equal(pending.extra.documentSha256, fakeSha);
        assert.equal(pending.extra.documentVia, "foxit-mcp");
        // Approval card can show the digest — never the raw payload JSON
        // (renderEsignPlan tested via agent-loop).
      } finally {
        j.cleanup();
      }
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  test("caller cannot override documentSha256 via extra", async () => {
    saveEnv();
    process.env.FOXIT_CLIENT_ID = "test-client-id";
    process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
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
      return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    };

    try {
      const { createEsignStore, createEsignFolder } = await importAdapter();
      const j = tmpJournal();
      try {
        const store = createEsignStore(j.path);
        const payload = {
          folderName: "override-test",
          recipients: [{ firstName: "Dan", lastName: "Brown", email: "dan@example.com" }],
        };
        const result = await createEsignFolder(store, payload, {
          extra: { documentSha256: "deadbeef".repeat(8), documentVia: "evil" },
        });
        const pending = store.listPending().find((p) => p.planToken === result.planToken);
        assert.equal(pending.extra.documentSha256, TINY_PDF_SHA256);
        assert.equal(pending.extra.documentVia, "fixture");
      } finally {
        j.cleanup();
      }
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});
