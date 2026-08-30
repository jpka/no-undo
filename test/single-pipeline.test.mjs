/**
 * Tests for the single-pipeline wiring (P6).
 *
 * Verifies that the agent loop collapses Nutrient enrichment + Foxit assembly
 * onto one PlanStore/approval queue, while keeping Foxit-only repro intact.
 * No live credentials — enrichment is best-effort and never blocks the send.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixtures = new Map();
function defaultFixtures() {
  fixtures.clear();
  fixtures.set("POST:/esign/api/v1/folders/createfolder", {
    ok: true, status: 200, json: { folder: { folderId: 35999999, folderName: "test", folderStatus: "DRAFT" } },
  });
  fixtures.set("POST:/esign/api/v1/folders/sendDraftFolder", {
    ok: true, status: 200, json: { result: "success" },
  });
  fixtures.set("GET:/esign/api/v1/folders/myfolder?folderId=35999999", {
    ok: true, status: 200, json: { folder: { folderId: 35999999, folderStatus: "SHARED" } },
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
      return { ok: fixture.ok, status: fixture.status, text: async () => JSON.stringify(fixture.json), json: async () => fixture.json };
    }
    return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({ error: "no fixture " + key }) };
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NO_FOXIT_MCP;
  delete process.env.NO_NUTRIENT;
  delete process.env.NUTRIENT_API_KEY;
  delete process.env.NUTRIENT_DWS_EXTRACTION_API_KEY;
});

function tmpJournal() {
  const dir = join(tmpdir(), "no-undo-pipeline-test-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "test-journal.jsonl");
  return {
    path,
    dir,
    cleanup: () => {
      for (const f of [path, join(dir, ".token-map.json"), join(dir, ".poll-state.json"), join(dir, "esign-audit.jsonl")]) {
        try { unlinkSync(f); } catch {}
      }
    },
  };
}

describe("single-pipeline (P6)", () => {
  test("shouldEnrichWithNutrient: false without keys (Foxit-only)", async () => {
    delete process.env.NUTRIENT_API_KEY;
    delete process.env.NUTRIENT_DWS_EXTRACTION_API_KEY;
    const { shouldEnrichWithNutrient } = await import("../agent/esign-agent-loop.mjs");
    assert.equal(shouldEnrichWithNutrient(), false);
  });

  test("shouldEnrichWithNutrient: false when NO_NUTRIENT=1 even with keys", async () => {
    process.env.NUTRIENT_API_KEY = "k1";
    process.env.NUTRIENT_DWS_EXTRACTION_API_KEY = "k2";
    process.env.NO_NUTRIENT = "1";
    const { shouldEnrichWithNutrient } = await import("../agent/esign-agent-loop.mjs");
    assert.equal(shouldEnrichWithNutrient(), false);
  });

  test("shouldEnrichWithNutrient: true when both keys present", async () => {
    process.env.NUTRIENT_API_KEY = "k1";
    process.env.NUTRIENT_DWS_EXTRACTION_API_KEY = "k2";
    const { shouldEnrichWithNutrient } = await import("../agent/esign-agent-loop.mjs");
    assert.equal(shouldEnrichWithNutrient(), true);
  });

  test("enrichWithNutrient returns null without keys (no throw)", async () => {
    const { enrichWithNutrient } = await import("../agent/esign-agent-loop.mjs");
    const r = await enrichWithNutrient({ folderName: "Test", docSource: null, promptExcerpt: "hi" });
    assert.equal(r, null);
  });

  test("enrichWithNutrient returns summary without bytes (wired but no file)", async () => {
    process.env.NUTRIENT_API_KEY = "k1";
    process.env.NUTRIENT_DWS_EXTRACTION_API_KEY = "k2";
    const { enrichWithNutrient } = await import("../agent/esign-agent-loop.mjs");
    const r = await enrichWithNutrient({ folderName: "Test", docSource: "nonexistent.pdf", promptExcerpt: "hi" });
    assert.ok(r && typeof r.summary === "string");
    assert.match(r.summary, /wired/);
  });

  test("enrichWithNutrient returns staged summary when docBytes provided", async () => {
    process.env.NUTRIENT_API_KEY = "k1";
    process.env.NUTRIENT_DWS_EXTRACTION_API_KEY = "k2";
    const { enrichWithNutrient } = await import("../agent/esign-agent-loop.mjs");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const r = await enrichWithNutrient({ folderName: "Test", docSource: null, promptExcerpt: "hi" }, { docBytes: bytes });
    assert.ok(r && typeof r.summary === "string");
    assert.match(r.summary, /staged|wired/);
    assert.equal(r.bytes.length, 4);
  });

  test("enrichWithNutrient makes a real extraction call and surfaces routing (gh #34)", async () => {
    process.env.NUTRIENT_API_KEY = "k1";
    process.env.NUTRIENT_DWS_EXTRACTION_API_KEY = "k2";
    const { enrichWithNutrient } = await import("../agent/esign-agent-loop.mjs");

    // Mock Nutrient extraction response — mirrors the live fixture shape:
    // two not_found fields (absent from data, present in metadata) and
    // recognitionScore values below the 0.8 floor on several fields.
    const nutrientResponse = {
      output: {
        data: {
          invoice_number: "INV-2026-0418",
          vendor_name: "ACME Freight",
          payer_name: "Kaniefsky Transport",
          total_amount: 26.86,
          tax_amount: 5.27,
        },
        metadata: {
          invoice_number: { match: "id_match", confidence: 0.95, confidenceComponents: { groundingScore: 0.95 }, recognitionScore: 0.95 },
          vendor_name: { match: "id_match", confidence: 0.95, confidenceComponents: { groundingScore: 0.95 }, recognitionScore: 0.76 },
          payer_name: { match: "id_match", confidence: 0.95, confidenceComponents: { groundingScore: 0.95 }, recognitionScore: 0.61 },
          total_amount: { match: "id_match", confidence: 0.97, confidenceComponents: { groundingScore: 0.95 }, recognitionScore: 0.68 },
          tax_amount: { match: "id_match", confidence: 0.97, confidenceComponents: { groundingScore: 0.95 }, recognitionScore: 0.57 },
          due_date: { match: "not_found", source_bboxes: [] },
          po_number: { match: "not_found", source_bboxes: [] },
        },
      },
    };

    // Capture the extraction URL to prove the real endpoint was called.
    let extractCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("api.nutrient.io/extraction/extract")) {
        extractCalled = true;
        return { ok: true, status: 200, text: async () => JSON.stringify(nutrientResponse), json: async () => nutrientResponse };
      }
      return origFetch(url, init);
    };

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const r = await enrichWithNutrient({ folderName: "Test", docSource: null, promptExcerpt: "hi" }, { docBytes: bytes });
    globalThis.fetch = origFetch;

    // The extraction endpoint was actually called.
    assert.ok(extractCalled, "expected the real /extraction/extract endpoint to be called");

    // The summary reflects the honest routing outcome — not a "wired" stub.
    assert.ok(r && typeof r.summary === "string");
    assert.match(r.summary, /1\/7 fields auto-approved/);
    assert.match(r.summary, /6 need human review/);
    // The OCR recognition floor caught the dissenting fields.
    assert.match(r.summary, /caught by OCR recognition floor/);
    assert.match(r.summary, /total_amount/);
    assert.match(r.summary, /tax_amount/);
    // The not_found fields are named (they live only in metadata).
    assert.match(r.summary, /ungrounded \(not_found\)/);
    assert.match(r.summary, /due_date/);
    assert.match(r.summary, /po_number/);
    // Thresholds are uncalibrated — say so honestly.
    assert.match(r.summary, /thresholds calibrated: false/);
    // The bytes are returned unchanged (enrichment is reversible).
    assert.equal(r.bytes.length, 4);
  });

  test("enrichWithNutrient degrades to Foxit-only on extraction HTTP error (gh #34)", async () => {
    process.env.NUTRIENT_API_KEY = "k1";
    process.env.NUTRIENT_DWS_EXTRACTION_API_KEY = "k2";
    const { enrichWithNutrient } = await import("../agent/esign-agent-loop.mjs");

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("api.nutrient.io/extraction/extract")) {
        return { ok: false, status: 403, text: async () => "Forbidden", json: async () => ({ error: "forbidden" }) };
      }
      return origFetch(url);
    };

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const r = await enrichWithNutrient({ folderName: "Test", docSource: null, promptExcerpt: "hi" }, { docBytes: bytes });
    globalThis.fetch = origFetch;

    // Degrades gracefully — returns bytes, reports the HTTP error honestly.
    assert.ok(r);
    assert.match(r.summary, /HTTP 403/);
    assert.match(r.summary, /Foxit-only path continues/);
    assert.equal(r.bytes.length, 4);
  });

  test("renderEsignPlan surfaces nutrientSummary", async () => {
    const { renderEsignPlan } = await import("../agent/esign-agent-loop.mjs");
    const plan = {
      payload: { folderName: "Demo", recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }] },
      extra: { folderId: 123, nutrientSummary: "Nutrient enrichment wired — 4 bytes" },
      reason: "test",
    };
    const rendered = renderEsignPlan(plan);
    const labels = rendered.details.map((d) => d.label);
    assert.ok(labels.includes("Nutrient enrichment"), `labels: ${labels.join(", ")}`);
  });

  test("runFromPrompt: Foxit-only path still executes end-to-end (no keys)", async () => {
    const { runFromPrompt } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    try {
      // Explicit recipients override the parser's synthesized @example.com
      // addresses (issue #27: bare names like "Alice and Bob" must not be
      // sent to fabricated addresses).
      const result = await runFromPrompt(
        "Take this freight invoice and send it to Alice and Bob for signature.",
        {
          journalPath: j.path,
          autoApprove: true,
          allowFixturePdf: true,
          recipients: [
            { firstName: "Alice", lastName: "Smith", email: "alice@example.com" },
            { firstName: "Bob", lastName: "Jones", email: "bob@example.com" },
          ],
        },
      );
      assert.equal(result.status, "executed");
      assert.ok(result.folderId);
    } finally {
      j.cleanup();
    }
  });

  test("runFromPrompt: with Nutrient keys, enrichment does not block execution", async () => {
    process.env.NUTRIENT_API_KEY = "k1";
    process.env.NUTRIENT_DWS_EXTRACTION_API_KEY = "k2";
    const { runFromPrompt, shouldEnrichWithNutrient } = await import("../agent/esign-agent-loop.mjs");
    assert.equal(shouldEnrichWithNutrient(), true);
    const j = tmpJournal();
    try {
      // Issue #27: bare names like "Alice and Bob" must not send to
      // @example.com. Explicit recipients override the parser's guesses.
      const result = await runFromPrompt(
        "Take this freight invoice and send it to Alice and Bob for signature.",
        {
          journalPath: j.path,
          autoApprove: true,
          allowFixturePdf: true,
          recipients: [
            { firstName: "Alice", lastName: "Smith", email: "alice@example.com" },
            { firstName: "Bob", lastName: "Jones", email: "bob@example.com" },
          ],
        },
      );
      assert.equal(result.status, "executed");
    } finally {
      j.cleanup();
    }
  });

  test("runAgentLoop: nutrientSummary flows into plan extra and is inspectable", async () => {
    const { renderEsignPlan } = await import("../agent/esign-agent-loop.mjs");
    // Directly verify renderEsignPlan handles nutrientSummary — integration via
    // createEsignFolder is covered by the Foxit-only end-to-end tests above.
    // Here just confirm the extra field round-trips through the approval card.
    const plan = {
      payload: { folderName: "Summary Test", recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }] },
      extra: { folderId: 35999999, nutrientSummary: "Nutrient enrichment wired — test", documentSha256: "abc", documentVia: "fixture" },
      reason: "test",
    };
    const rendered = renderEsignPlan(plan);
    assert.ok(rendered.details.some((d) => d.label === "Nutrient enrichment" && d.value.includes("wired")));
    assert.ok(rendered.details.some((d) => d.label === "Document SHA-256"));
  });

  test("runAgentLoop threads enriched pdfBytes through createEsignFolder (gh #33)", async () => {
    // gh #33: the CLI path (runAgentLoop → createEsignFolder) must forward enriched
    // bytes so the digest matches the bytes actually sent. The old test called
    // createEsignFolder directly with bytes identical to the fixture — the digest
    // didn't change, so it passed without proving a different document was hashed.
    // Here we drive the real CLI path with genuinely different bytes and assert
    // the digest changes from the fixture's.
    const { runAgentLoop } = await import("../agent/esign-agent-loop.mjs");
    const { TINY_PDF_BASE64, TINY_PDF_SHA256, sha256Base64 } = await import("../mcp/foxit/pdf-assembly.mjs");
    const { renderEsignPlan } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    // A tagged PDF that genuinely differs from TINY_PDF_BASE64 — the digest must
    // change, proving createEsignFolder hashed the enriched bytes, not the fixture.
    const taggedPdf = "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >>\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >>\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\n4 0 obj << /Length 50 >>\nstream\nBT /F1 12 Tf 50 700 Td (${signfield:1:y:____}) Tj ET\nendstream\nendobj\ntrailer << /Root 1 0 R >>";
    const enrichedBytes = Buffer.from(taggedPdf, "latin1");
    const enrichedDigest = sha256Base64(enrichedBytes.toString("base64"));
    assert.notEqual(enrichedDigest, TINY_PDF_SHA256, "enriched bytes must differ from fixture");
    try {
      const result = await runAgentLoop({
        folderName: "Enriched CLI Test",
        recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }],
        journalPath: j.path,
        autoApprove: true,
        allowFixturePdf: true,
        pdfBytes: enrichedBytes,
      });
      assert.equal(result.status, "executed", "send should succeed through the real CLI path");
      // The approval card must show the enriched document's digest, not the fixture's.
      assert.notEqual(result.documentSha256, TINY_PDF_SHA256, "documentSha256 must reflect enriched bytes, not fixture");
      assert.equal(result.documentSha256, enrichedDigest, "digest must match hash of enriched bytes sent to gateway");
      assert.equal(result.documentVia, "enriched-source", "documentVia must indicate enriched-source when pdfBytes threaded");
    } finally {
      j.cleanup();
    }
  });
});
