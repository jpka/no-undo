/**
 * Tests for Foxit PDF assembly (B: real Foxit PDF wiring) + review follow-ups.
 *
 * Covers:
 * - buildInvoiceHtml produces deterministic judge-legible HTML
 * - assemblePdf fixture seam (NO_FOXIT_MCP / FOXIT_PDF_FIXTURE / missing creds)
 * - createEsignFolder wires the assembled bytes + SHA-256 into the gate
 * - SHA-256 recomputed from bytes (injected sha ignored)
 * - Options pass-through (pdfHtml, pdfTimeoutMs)
 * - pdfHtmlPreview not persisted
 * - renderEsignPlan surfaces digest without leaking PII
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
import { renderEsignPlan } from "../agent/esign-agent-loop.mjs";

function tmpJournal() {
  const dir = join(tmpdir(), "no-undo-pdf-test-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "test-journal.jsonl");
  return {
    path,
    dir,
    cleanup: () => {
      for (const f of [path, `${path}.tmp`, join(dir, ".token-map.json"), join(dir, ".token-map.json.tmp"), join(dir, ".webhook-dedup.json"), join(dir, ".webhook-dedup.json.tmp"), join(dir, "esign-audit.jsonl")]) {
        try { unlinkSync(f); } catch {}
      }
      try { const { rmdirSync } = awaitImportSync(); } catch {}
    },
  };
}
function awaitImportSync() { return null; }

describe("pdf-assembly — buildInvoiceHtml", () => {
  test("includes folder name and recipients", () => {
    const html = buildInvoiceHtml({
      folderName: "Freight Invoice",
      recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }],
      instructions: "redact PII",
    });
    assert.match(html, /Freight Invoice/);
    assert.match(html, /Alice Smith/);
    // The signer's own address must NOT reach the document body. Foxit carries
    // recipient addresses in `parties`; rendering it here created a redaction
    // target sitting on top of a Foxit Text Tag, and applying the redaction
    // destroyed the signature field (docs/nutrient-redaction-sep1.md, Finding 2).
    assert.doesNotMatch(html, /alice@example\.com/);
    assert.match(html, /redact PII/);
    assert.match(html, /foxit/i);
    assert.doesNotMatch(html, /<script/);
  });

  test("renders the third-party PII the redaction pass targets", () => {
    const html = buildInvoiceHtml({
      folderName: "Freight Invoice",
      recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }],
    });
    // These are the redaction targets: driver contact, tractor VIN, AP contact.
    // Without them the prompt's "redact the PII" has nothing to act on.
    assert.match(html, /m\.webb@acmefreight-drivers\.example/);
    assert.match(html, /\(201\) 555-0142/);
    assert.match(html, /1FUJGLDR8CLBP8834/);
    assert.match(html, /ap@kaniefsky-transport\.example/);
    assert.match(html, /Shipment contacts/);
    // The signature tag must exist and must not sit inside the PII block —
    // a redaction box overlapping it destroys the field (Finding 2).
    assert.match(html, /\$\{signfield:1:y:____\}/);
    assert.ok(
      html.indexOf("Shipment contacts") < html.indexOf("${signfield:1:y:____}"),
      "shipment PII must be rendered before (and away from) the signature blocks",
    );
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

  test("falls back to fixture title for empty folderName", () => {
    const html = buildInvoiceHtml({ folderName: "", recipients: [] });
    // Empty folderName falls back to the shared fixture's title (ACME Freight Services)
    assert.match(html, /ACME Freight Services/);
  });

  test("renders docSource and default instructions when instructions null", () => {
    const html = buildInvoiceHtml({ folderName: "Contract", recipients: [], instructions: null, docSource: "invoice.pdf" });
    assert.match(html, /invoice\.pdf/);
    assert.match(html, /reversible assembly/);
  });

  test("handles multiple recipients and empty recipients array", () => {
    const htmlMulti = buildInvoiceHtml({
      folderName: "Multi",
      recipients: [
        { firstName: "A", lastName: "One", email: "a@example.com" },
        { firstName: "B", lastName: "Two", email: "b@example.com" },
      ],
    });
    assert.match(htmlMulti, /A One/);
    assert.match(htmlMulti, /B Two/);
    // Neither signer's address appears in the body — see Finding 2.
    assert.doesNotMatch(htmlMulti, /a@example\.com/);
    assert.doesNotMatch(htmlMulti, /b@example\.com/);
    const htmlEmpty = buildInvoiceHtml({ folderName: "Empty", recipients: [] });
    assert.match(htmlEmpty, /<tbody><\/tbody>/);
  });

  test("output is self-contained (no external CSS/JS)", () => {
    const html = buildInvoiceHtml({ folderName: "X", recipients: [{ firstName: "A", lastName: "B", email: "a@b.com" }] });
    assert.doesNotMatch(html, /<link rel="stylesheet"/);
    assert.doesNotMatch(html, /<script src=/);
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

  test("returns fixture when FOXIT_PDF_FIXTURE=1", async () => {
    const orig = process.env.FOXIT_PDF_FIXTURE;
    process.env.FOXIT_PDF_FIXTURE = "1";
    const orig2 = process.env.NO_FOXIT_MCP;
    delete process.env.NO_FOXIT_MCP;
    const savedCreds = { id: process.env.FOXIT_CLIENT_ID, sec: process.env.FOXIT_CLIENT_SECRET };
    // Provide dummy creds so hasCreds true but forceFixture still wins
    process.env.FOXIT_CLIENT_ID = "real-id";
    process.env.FOXIT_CLIENT_SECRET = "real-secret";
    try {
      const res = await assemblePdf({ folderName: "Fixture2", recipients: [] });
      assert.equal(res.via, "fixture");
      assert.equal(res.base64, TINY_PDF_BASE64);
    } finally {
      if (orig === undefined) delete process.env.FOXIT_PDF_FIXTURE;
      else process.env.FOXIT_PDF_FIXTURE = orig;
      if (orig2 === undefined) delete process.env.NO_FOXIT_MCP;
      else process.env.NO_FOXIT_MCP = orig2;
      if (savedCreds.id === undefined) delete process.env.FOXIT_CLIENT_ID; else process.env.FOXIT_CLIENT_ID = savedCreds.id;
      if (savedCreds.sec === undefined) delete process.env.FOXIT_CLIENT_SECRET; else process.env.FOXIT_CLIENT_SECRET = savedCreds.sec;
    }
  });

  test("returns fixture when FOXIT_PDF_FORCE_MCP=0", async () => {
    const orig = process.env.FOXIT_PDF_FORCE_MCP;
    process.env.FOXIT_PDF_FORCE_MCP = "0";
    const savedCreds = { id: process.env.FOXIT_CLIENT_ID, sec: process.env.FOXIT_CLIENT_SECRET };
    process.env.FOXIT_CLIENT_ID = "real-id";
    process.env.FOXIT_CLIENT_SECRET = "real-secret";
    try {
      const res = await assemblePdf({ folderName: "ForceMcp", recipients: [] });
      assert.equal(res.via, "fixture");
    } finally {
      if (orig === undefined) delete process.env.FOXIT_PDF_FORCE_MCP;
      else process.env.FOXIT_PDF_FORCE_MCP = orig;
      if (savedCreds.id === undefined) delete process.env.FOXIT_CLIENT_ID; else process.env.FOXIT_CLIENT_ID = savedCreds.id;
      if (savedCreds.sec === undefined) delete process.env.FOXIT_CLIENT_SECRET; else process.env.FOXIT_CLIENT_SECRET = savedCreds.sec;
    }
  });

  test("returns fixture when no credentials at all", async () => {
    const stash = { ...process.env };
    delete process.env.FOXIT_CLIENT_ID;
    delete process.env.FOXIT_CLIENT_SECRET;
    delete process.env.FOXIT_CLOUD_API_CLIENT_ID;
    delete process.env.FOXIT_CLOUD_API_CLIENT_SECRET;
    delete process.env.NO_FOXIT_MCP;
    delete process.env.FOXIT_PDF_FIXTURE;
    delete process.env.FOXIT_PDF_FORCE_MCP;
    try {
      const res = await assemblePdf({ folderName: "NoCreds", recipients: [] });
      assert.equal(res.via, "fixture");
      assert.equal(res.base64, TINY_PDF_BASE64);
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      for (const [k, v] of Object.entries(stash)) process.env[k] = v;
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

  test("sha256Base64 rejects invalid base64", () => {
    assert.throws(() => sha256Base64("!!!not base64!!!"), /invalid base64/);
  });
});

describe("esign-adapter — wired PDF assembly via createEsignFolder", () => {
  let originalFetch;
  let originalEnv;

  function saveEnv() { originalEnv = { ...process.env }; }
  function restoreEnv() {
    for (const k of Object.keys(process.env)) delete process.env[k];
    for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v;
  }

  const fixtures = new Map();
  function defaultFixtures() {
    fixtures.clear();
    fixtures.set("GET:/esign/api/v1/folders/myfolder?folderId=35426627", {
      ok: true, status: 200, json: { result: "success", folder: { folderId: 35426627, folderName: "test", folderStatus: "DRAFT" } },
    });
    fixtures.set("POST:/esign/api/v1/folders/createfolder", {
      ok: true, status: 200, json: { folder: { folderId: 35426627, folderName: "test", folderStatus: "DRAFT" } },
    });
    fixtures.set("POST:/esign/api/v1/folders/sendDraftFolder", {
      ok: true, status: 200, json: { result: "success" },
    });
  }

  async function importAdapter() { return await import("../mcp/foxit/esign-adapter.mjs"); }

  test("extra.documentSha256 matches the bytes actually sent (fixture path)", async () => {
    saveEnv();
    process.env.NO_FOXIT_MCP = "1";
    process.env.FOXIT_CLIENT_ID = "test-client-id";
    process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
    defaultFixtures();
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const key = `${init.method ?? "GET"}:${u.pathname}${u.search}`;
      const fixture = fixtures.get(key);
      if (key === "POST:/esign/api/v1/folders/createfolder") {
        const body = JSON.parse(init.body);
        assert.ok(Array.isArray(body.base64FileString));
        assert.equal(body.base64FileString.length, 1);
        assert.equal(body.base64FileString[0], TINY_PDF_BASE64);
      }
      if (fixture) return { ok: fixture.ok, status: fixture.status, text: async () => fixture.text ?? JSON.stringify(fixture.json), json: async () => fixture.json };
      return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    };
    try {
      const { createEsignStore, createEsignFolder } = await importAdapter();
      const j = tmpJournal();
      try {
        const store = createEsignStore(j.path);
        const payload = { folderName: "assembly-wired-test", recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }] };
        const result = await createEsignFolder(store, payload);
        assert.ok(result.planToken);
        const pending = store.listPending().find((p) => p.planToken === result.planToken);
        assert.ok(pending, "plan should be pending");
        assert.equal(pending.extra.documentSha256, TINY_PDF_SHA256);
        assert.equal(pending.extra.documentVia, "fixture");
        assert.equal(pending.extra.folderId, 35426627);
        assert.equal(pending.extra.pdfHtmlPreview, undefined);
      } finally {
        try { unlinkSync(j.path); } catch {}
        try { unlinkSync(`${j.path}.tmp`); } catch {}
        try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
        try { unlinkSync(join(j.dir, ".token-map.json.tmp")); } catch {}
        try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
        try { unlinkSync(join(j.dir, ".webhook-dedup.json.tmp")); } catch {}
        try { unlinkSync(join(j.dir, "esign-audit.jsonl")); } catch {}
      }
    } finally { globalThis.fetch = originalFetch; restoreEnv(); }
  });

  test("injected assemblePdf (foxit-mcp) wires its bytes + sha into the plan and request — sha recomputed", async () => {
    saveEnv();
    process.env.NO_FOXIT_MCP = "1";
    process.env.FOXIT_CLIENT_ID = "test-client-id";
    process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
    defaultFixtures();
    const fakeBytes = Buffer.from("%PDF-1.4 fake content for test");
    const fakeBase64 = fakeBytes.toString("base64");
    const fakeSha = createHash("sha256").update(fakeBytes).digest("hex");
    const evilSha = "deadbeef".repeat(8);
    const fakeHtml = "<html>fake</html>";
    let capturedBody = null;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const key = `${init.method ?? "GET"}:${u.pathname}${u.search}`;
      const fixture = fixtures.get(key);
      if (key === "POST:/esign/api/v1/folders/createfolder") capturedBody = JSON.parse(init.body);
      if (fixture) return { ok: fixture.ok, status: fixture.status, text: async () => fixture.text ?? JSON.stringify(fixture.json), json: async () => fixture.json };
      return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    };
    try {
      const { createEsignStore, createEsignFolder } = await importAdapter();
      const j = tmpJournal();
      try {
        const store = createEsignStore(j.path);
        const payload = { folderName: "foxit-mcp-wired", recipients: [{ firstName: "Carol", lastName: "White", email: "carol@example.com" }] };
        const fakeAssemble = async () => ({ base64: fakeBase64, sha256: evilSha, html: fakeHtml, via: "foxit-mcp" });
        const result = await createEsignFolder(store, payload, { assemblePdf: fakeAssemble });
        assert.ok(result.planToken);
        assert.ok(capturedBody);
        assert.equal(capturedBody.base64FileString[0], fakeBase64);
        const pending = store.listPending().find((p) => p.planToken === result.planToken);
        assert.ok(pending);
        // sha recomputed from bytes, not trusted injected evilSha
        assert.equal(pending.extra.documentSha256, fakeSha);
        assert.notEqual(pending.extra.documentSha256, evilSha);
        assert.equal(pending.extra.documentVia, "foxit-mcp");
        assert.equal(pending.extra.pdfHtmlPreview, undefined);
      } finally {
        try { unlinkSync(j.path); } catch {}
        try { unlinkSync(`${j.path}.tmp`); } catch {}
        try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
        try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
        try { unlinkSync(join(j.dir, "esign-audit.jsonl")); } catch {}
      }
    } finally { globalThis.fetch = originalFetch; restoreEnv(); }
  });

  test("caller cannot override documentSha256 via extra", async () => {
    saveEnv();
    process.env.NO_FOXIT_MCP = "1";
    process.env.FOXIT_CLIENT_ID = "test-client-id";
    process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
    defaultFixtures();
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const key = `${init.method ?? "GET"}:${u.pathname}${u.search}`;
      const fixture = fixtures.get(key);
      if (fixture) return { ok: fixture.ok, status: fixture.status, text: async () => fixture.text ?? JSON.stringify(fixture.json), json: async () => fixture.json };
      return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    };
    try {
      const { createEsignStore, createEsignFolder } = await importAdapter();
      const j = tmpJournal();
      try {
        const store = createEsignStore(j.path);
        const payload = { folderName: "override-test", recipients: [{ firstName: "Dan", lastName: "Brown", email: "dan@example.com" }] };
        const result = await createEsignFolder(store, payload, { extra: { documentSha256: "deadbeef".repeat(8), documentVia: "evil", promptExcerpt: "keep me", customKey: "preserved" } });
        const pending = store.listPending().find((p) => p.planToken === result.planToken);
        assert.equal(pending.extra.documentSha256, TINY_PDF_SHA256);
        assert.equal(pending.extra.documentVia, "fixture");
        assert.equal(pending.extra.promptExcerpt, "keep me");
        assert.equal(pending.extra.customKey, "preserved");
      } finally {
        try { unlinkSync(j.path); } catch {}
        try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
        try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
        try { unlinkSync(join(j.dir, "esign-audit.jsonl")); } catch {}
      }
    } finally { globalThis.fetch = originalFetch; restoreEnv(); }
  });

  test("assemblePdf throwing falls back to fixture when NO_FOXIT_MCP=1, fails closed with live creds", async () => {
    // Fallback path
    saveEnv();
    process.env.NO_FOXIT_MCP = "1";
    process.env.FOXIT_CLIENT_ID = "test-client-id";
    process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
    defaultFixtures();
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const key = `${init.method ?? "GET"}:${u.pathname}${u.search}`;
      const fixture = fixtures.get(key);
      if (fixture) {
        if (key === "POST:/esign/api/v1/folders/createfolder") {
          const body = JSON.parse(init.body);
          assert.equal(body.base64FileString[0], TINY_PDF_BASE64);
        }
        return { ok: fixture.ok, status: fixture.status, text: async () => JSON.stringify(fixture.json), json: async () => fixture.json };
      }
      return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    };
    try {
      const { createEsignStore, createEsignFolder } = await importAdapter();
      const j = tmpJournal();
      try {
        const store = createEsignStore(j.path);
        const payload = { folderName: "throw-fallback", recipients: [{ firstName: "Eve", lastName: "Davis", email: "eve@example.com" }] };
        const throwingAssemble = async () => { throw new Error("mcp down"); };
        const result = await createEsignFolder(store, payload, { assemblePdf: throwingAssemble });
        assert.ok(result.planToken);
        const pending = store.listPending().find((p) => p.planToken === result.planToken);
        assert.equal(pending.extra.documentVia, "fixture");
        assert.equal(pending.extra.documentSha256, TINY_PDF_SHA256);
      } finally {
        try { unlinkSync(j.path); } catch {}
        try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
        try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
        try { unlinkSync(join(j.dir, "esign-audit.jsonl")); } catch {}
      }
    } finally { globalThis.fetch = originalFetch; restoreEnv(); }

    // Fail-closed path with live creds
    saveEnv();
    delete process.env.NO_FOXIT_MCP;
    delete process.env.FOXIT_PDF_FIXTURE;
    process.env.FOXIT_CLIENT_ID = "real-live-id";
    process.env.FOXIT_CLIENT_SECRET = "real-live-secret";
    defaultFixtures();
    let fetchCalled = false;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: false, status: 500, text: async () => "x", json: async () => ({}) }; };
    try {
      const { createEsignStore, createEsignFolder } = await importAdapter();
      const j2 = tmpJournal();
      try {
        const store = createEsignStore(j2.path);
        const payload = { folderName: "throw-live", recipients: [{ firstName: "Eve", lastName: "Davis", email: "eve@example.com" }] };
        const throwingAssemble2 = async () => { throw new Error("mcp down live"); };
        const result = await createEsignFolder(store, payload, { assemblePdf: throwingAssemble2 });
        assert.ok(result.error);
        assert.match(result.error, /mcp down live/);
        assert.equal(fetchCalled, false);
      } finally {
        try { unlinkSync(j2.path); } catch {}
        try { unlinkSync(join(j2.dir, ".token-map.json")); } catch {}
        try { unlinkSync(join(j2.dir, ".webhook-dedup.json")); } catch {}
        try { unlinkSync(join(j2.dir, "esign-audit.jsonl")); } catch {}
      }
    } finally { globalThis.fetch = originalFetch; restoreEnv(); }
  });

  test("assemblePdf returning no base64 falls back to fixture", async () => {
    saveEnv();
    process.env.NO_FOXIT_MCP = "1";
    process.env.FOXIT_CLIENT_ID = "test-client-id";
    process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
    defaultFixtures();
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const key = `${init.method ?? "GET"}:${u.pathname}${u.search}`;
      const fixture = fixtures.get(key);
      if (fixture) return { ok: fixture.ok, status: fixture.status, text: async () => JSON.stringify(fixture.json), json: async () => fixture.json };
      return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    };
    try {
      const { createEsignStore, createEsignFolder } = await importAdapter();
      const j = tmpJournal();
      try {
        const store = createEsignStore(j.path);
        const payload = { folderName: "no-base64", recipients: [{ firstName: "F", lastName: "B", email: "f@example.com" }] };
        const emptyAssemble = async () => ({ html: "<html>hi</html>", via: "fixture" });
        const result = await createEsignFolder(store, payload, { assemblePdf: emptyAssemble });
        assert.ok(result.planToken);
        const pending = store.listPending().find((p) => p.planToken === result.planToken);
        assert.equal(pending.extra.documentVia, "fixture");
        assert.equal(pending.extra.documentSha256, TINY_PDF_SHA256);
      } finally {
        try { unlinkSync(j.path); } catch {}
        try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
        try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
        try { unlinkSync(join(j.dir, "esign-audit.jsonl")); } catch {}
      }
    } finally { globalThis.fetch = originalFetch; restoreEnv(); }
  });

  test("options pdfHtml and pdfTimeoutMs reach assemblePdf", async () => {
    saveEnv();
    process.env.NO_FOXIT_MCP = "1";
    process.env.FOXIT_CLIENT_ID = "test-client-id";
    process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
    defaultFixtures();
    let capturedOpts = null;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const key = `${init.method ?? "GET"}:${u.pathname}${u.search}`;
      const fixture = fixtures.get(key);
      if (fixture) return { ok: fixture.ok, status: fixture.status, text: async () => JSON.stringify(fixture.json), json: async () => fixture.json };
      return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    };
    try {
      const { createEsignStore, createEsignFolder } = await importAdapter();
      const j = tmpJournal();
      try {
        const store = createEsignStore(j.path);
        const payload = { folderName: "opts-test", recipients: [{ firstName: "G", lastName: "H", email: "g@example.com" }] };
        const spyAssemble = async (p, opts) => { capturedOpts = opts; return { base64: TINY_PDF_BASE64, sha256: TINY_PDF_SHA256, html: opts.html, via: "fixture" }; };
        await createEsignFolder(store, payload, { assemblePdf: spyAssemble, pdfHtml: "<html>custom</html>", pdfTimeoutMs: 12345 });
        assert.equal(capturedOpts.html, "<html>custom</html>");
        assert.equal(capturedOpts.timeoutMs, 12345);
      } finally {
        try { unlinkSync(j.path); } catch {}
        try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
        try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
        try { unlinkSync(join(j.dir, "esign-audit.jsonl")); } catch {}
      }
    } finally { globalThis.fetch = originalFetch; restoreEnv(); }
  });

  test("pdfHtmlPreview not stored in extra even when html small", async () => {
    saveEnv();
    process.env.NO_FOXIT_MCP = "1";
    process.env.FOXIT_CLIENT_ID = "test-client-id";
    process.env.FOXIT_CLIENT_SECRET = "test-client-secret";
    defaultFixtures();
    const smallHtml = "<html>small</html>";
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const key = `${init.method ?? "GET"}:${u.pathname}${u.search}`;
      const fixture = fixtures.get(key);
      if (fixture) return { ok: fixture.ok, status: fixture.status, text: async () => JSON.stringify(fixture.json), json: async () => fixture.json };
      return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    };
    try {
      const { createEsignStore, createEsignFolder } = await importAdapter();
      const j = tmpJournal();
      try {
        const store = createEsignStore(j.path);
        const payload = { folderName: "preview-test", recipients: [{ firstName: "H", lastName: "I", email: "h@example.com" }] };
        const assemble = async () => ({ base64: TINY_PDF_BASE64, sha256: TINY_PDF_SHA256, html: smallHtml, via: "fixture" });
        const res = await createEsignFolder(store, payload, { assemblePdf: assemble });
        const pending = store.listPending().find((p) => p.planToken === res.planToken);
        assert.equal(pending.extra.pdfHtmlPreview, undefined);
      } finally {
        try { unlinkSync(j.path); } catch {}
        try { unlinkSync(join(j.dir, ".token-map.json")); } catch {}
        try { unlinkSync(join(j.dir, ".webhook-dedup.json")); } catch {}
        try { unlinkSync(join(j.dir, "esign-audit.jsonl")); } catch {}
      }
    } finally { globalThis.fetch = originalFetch; restoreEnv(); }
  });
});

describe("renderEsignPlan — approval card", () => {
  test("shows Document SHA-256 row as '<hex> (via fixture)' when set", () => {
    const plan = {
      payload: { folderName: "My Folder", folderId: "123", recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }] },
      extra: { documentSha256: "abc123".repeat(10) + "abcd".slice(0, 4), documentVia: "fixture", folderId: "123" },
      reason: "test",
    };
    const card = renderEsignPlan(plan);
    const shaRow = card.details.find((d) => d.label === "Document SHA-256");
    assert.ok(shaRow);
    assert.match(shaRow.value, /via fixture/);
    assert.match(shaRow.value, /abc123/);
  });

  test("shows Document SHA-256 row as '<hex> (via foxit-mcp)' when via=foxit-mcp", () => {
    const hex = "f".repeat(64);
    const plan = { payload: { folderName: "F", recipients: [] }, extra: { documentSha256: hex, documentVia: "foxit-mcp" }, reason: "r" };
    const card = renderEsignPlan(plan);
    const row = card.details.find((d) => d.label === "Document SHA-256");
    assert.ok(row);
    assert.equal(row.value, `${hex} (via foxit-mcp)`);
  });

  test("shows only hex when via missing", () => {
    const hex = "a".repeat(64);
    const plan = { payload: { folderName: "F", recipients: [] }, extra: { documentSha256: hex }, reason: "r" };
    const card = renderEsignPlan(plan);
    const row = card.details.find((d) => d.label === "Document SHA-256");
    assert.equal(row.value, hex);
  });

  test("omits Document SHA-256 row when falsy", () => {
    const plan = { payload: { folderName: "F", recipients: [] }, extra: {}, reason: "r" };
    const card = renderEsignPlan(plan);
    assert.equal(card.details.some((d) => d.label === "Document SHA-256"), false);
  });

  test("does NOT leak raw payload JSON, base64, pdfHtmlPreview, or html", () => {
    const hex = "b".repeat(64);
    const plan = {
      payload: { folderName: "SecretFolder", recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }] },
      extra: { documentSha256: hex, documentVia: "fixture", pdfHtmlPreview: "<html>leak</html>", folderId: "999", promptExcerpt: "do thing" },
      reason: "r",
    };
    const card = renderEsignPlan(plan);
    const json = JSON.stringify(card);
    assert.doesNotMatch(json, /base64FileString/);
    assert.doesNotMatch(json, /leak/);
    assert.doesNotMatch(json, /<html>/);
    // Recipients are intentionally displayed (approval decision), but raw JSON blob is not
    assert.doesNotMatch(json, /"payload"/);
  });

  test("title and details contain folderName without raw JSON", () => {
    const plan = { payload: { folderName: "Freight Invoice", recipients: [] }, extra: {}, reason: "r" };
    const card = renderEsignPlan(plan);
    assert.match(card.title, /Freight Invoice/);
    const folderRow = card.details.find((d) => d.label === "Folder");
    assert.equal(folderRow.value, "Freight Invoice");
  });
});
