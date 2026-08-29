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
    ok: true, status: 200, json: { folder: { folderId: 35999999, folderStatus: "DRAFT" } },
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
      const result = await runFromPrompt(
        "Take this freight invoice and send it to Alice and Bob for signature.",
        { journalPath: j.path, autoApprove: true },
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
      const result = await runFromPrompt(
        "Take this freight invoice and send it to Alice and Bob for signature.",
        { journalPath: j.path, autoApprove: true },
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

  test("createEsignFolder threads pdfBytes through (no discarded staged bytes)", async () => {
    // P6 Greptile P1 follow-up: when enrichment resolves source bytes, they must
    // be threaded into Foxit assembly so the approval card describes exactly what
    // Foxit sends — not a freshly assembled invoice.
    const { createEsignFolder } = await import("../mcp/foxit/esign-adapter.mjs");
    const { renderEsignPlan } = await import("../agent/esign-agent-loop.mjs");
    const { loadEsignStore } = await import("../mcp/foxit/esign-adapter.mjs");
    const j = tmpJournal();
    // Use a tiny valid PDF as the "enriched source bytes"
    const tinyPdfBase64 =
      "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAw" +
      "IG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8" +
      "PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXT4+CmVuZG9iagp0" +
      "cmFpbGVyCjw8L1Jvb3QgMSAwIFI+Pg==";
    const pdfBytes = Buffer.from(tinyPdfBase64, "base64");
    try {
      const store = await loadEsignStore(j.path);
      const result = await createEsignFolder(
        store,
        { folderName: "Enriched Doc", recipients: [{ firstName: "Alice", lastName: "Smith", email: "alice@example.com" }] },
        { pdfBytes, extra: { nutrientSummary: "Nutrient enrichment wired — 4 bytes" } },
      );
      assert.ok(result.planToken, "planToken present");
      // Verify the plan's extra shows enriched-source via (the bytes were threaded, not discarded)
      const pending = store.listPending();
      assert.equal(pending.length, 1);
      const rendered = renderEsignPlan(pending[0]);
      assert.ok(rendered.details.some((d) => d.label === "Nutrient enrichment"));
      const viaDetail = rendered.details.find((d) => d.label === "Document SHA-256");
      assert.ok(viaDetail, "Document SHA-256 detail present");
      assert.match(viaDetail.value, /enriched-source/, "documentVia should be enriched-source when pdfBytes threaded");
    } finally {
      j.cleanup();
    }
  });
});
