/**
 * Tests for mcp/nutrient/pipeline-redaction.mjs
 *
 * Mocks global fetch — no live API calls. The VIN preset subtlety is the
 * point: preset "vin" is accepted (200) but matches nothing (Finding 4), so
 * DEFAULT_TARGETS must carry the VIN as a regex instead.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { INVOICE } from "../mcp/fixtures/invoice-data.mjs";

// Ensure keys exist before the module under test reads them lazily.
// PARSE_URL / BUILD_URL are captured at import time with defaults, so the
// actual value is irrelevant — the mock routes on URL substring.
process.env.NUTRIENT_API_KEY = "test-processor-key";
process.env.NUTRIENT_DWS_EXTRACTION_API_KEY = "test-extraction-key";

import {
  DEFAULT_TARGETS,
  parseDocumentText,
  piiValuesOf,
  redactForSignature,
  verifyRedaction,
} from "../mcp/nutrient/pipeline-redaction.mjs";

// Distinct bodies so the "applied not staged" assertion is real.
const STAGED_BYTES = new TextEncoder().encode("STAGED-PDF-BYTESTAGED-".repeat(20));
const APPLIED_BYTES = new TextEncoder().encode("APPLIED-PDF-BYTESAPPLIED-".repeat(20));
// Small doc used as input to redactForSignature
const DOC = new TextEncoder().encode("%PDF-1.4 invoice assembly with signfield tags");

let originalFetch;
let origProcessorKey;
let origExtractionKey;

beforeEach(() => {
  origProcessorKey = process.env.NUTRIENT_API_KEY;
  origExtractionKey = process.env.NUTRIENT_DWS_EXTRACTION_API_KEY;
  process.env.NUTRIENT_API_KEY = "test-processor-key";
  process.env.NUTRIENT_DWS_EXTRACTION_API_KEY = "test-extraction-key";
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (origProcessorKey === undefined) delete process.env.NUTRIENT_API_KEY;
  else process.env.NUTRIENT_API_KEY = origProcessorKey;
  if (origExtractionKey === undefined) delete process.env.NUTRIENT_DWS_EXTRACTION_API_KEY;
  else process.env.NUTRIENT_DWS_EXTRACTION_API_KEY = origExtractionKey;
});

/**
 * Build a fetch mock that routes on URL:
 *  - /build  -> binary PDF (stage vs apply distinguished by call order)
 *  - /extraction/parse -> text
 *
 * @param {object} opts
 * @param {string} [opts.parseText] text returned by /extraction/parse
 * @param {boolean} [opts.parseOk] whether /extraction/parse is 2xx
 * @param {number} [opts.parseStatus] HTTP status for parse
 * @param {boolean} [opts.failStage] first /build fails
 * @param {boolean} [opts.failApply] second /build fails
 * @param {Uint8Array} [opts.stageBytes]
 * @param {Uint8Array} [opts.appliedBytes]
 */
function installMock({
  parseText = "signfield:1:y signfield:2:y clean document",
  parseOk = true,
  parseStatus = 200,
  failStage = false,
  failApply = false,
  stageBytes = STAGED_BYTES,
  appliedBytes = APPLIED_BYTES,
} = {}) {
  let buildCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/extraction/parse")) {
      return {
        ok: parseOk,
        status: parseStatus,
        text: async () => parseText,
        arrayBuffer: async () => new TextEncoder().encode(parseText).buffer,
      };
    }
    if (u.includes("/build")) {
      buildCalls += 1;
      // Route on what the request ASKS FOR, not on call order. redactForSignature
      // no longer always makes a staging call (it is billed and its result is
      // locally derivable), so an order-based mock would hand the staged body to
      // the apply call and the staged-vs-applied assertion would pass vacuously.
      // An apply request is the one carrying the applyRedactions action.
      let instructions = "";
      try {
        instructions = String((init.body && init.body.get && init.body.get("instructions")) ?? "");
      } catch {
        instructions = "";
      }
      const isStage = !instructions.includes("applyRedactions");
      if (isStage && failStage) {
        return {
          ok: false,
          status: 422,
          text: async () => "stage failed",
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      if (!isStage && failApply) {
        return {
          ok: false,
          status: 422,
          text: async () => "apply failed",
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      const bytes = isStage ? stageBytes : appliedBytes;
      // Return a copy's buffer to avoid aliasing between stage/applied
      const buf = bytes.slice().buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      // The adapter also reads FormData instructions; we don't need to validate them here
      return {
        ok: true,
        status: 200,
        text: async () => "",
        arrayBuffer: async () => buf,
      };
    }
    // Fallback — should not be hit
    return { ok: false, status: 404, text: async () => "no fixture", arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

// ---------------------------------------------------------------------------
// 1. DEFAULT_TARGETS
// ---------------------------------------------------------------------------

describe("DEFAULT_TARGETS", () => {
  test("is frozen", () => {
    assert.equal(Object.isFrozen(DEFAULT_TARGETS), true, "DEFAULT_TARGETS must be frozen");
  });

  test("uses a REGEX for the VIN, not preset 'vin'", () => {
    // Every target that is a preset must not be 'vin' — Finding 4: preset 'vin'
    // returns 200 and redacts nothing. The regression is silent, so this guard
    // must stay even though the text looks like a preset name.
    for (const t of DEFAULT_TARGETS) {
      if (t.strategy === "preset") {
        assert.notEqual(t.preset, "vin", "no target may use preset 'vin'");
      }
    }
    const vinTarget = DEFAULT_TARGETS.find((t) => t.strategy === "regex");
    assert.ok(vinTarget, "expected a regex target for the VIN");
    assert.equal(vinTarget.regex, "[A-HJ-NPR-Z0-9]{17}");
  });

  test("contains the expected three targets", () => {
    const presets = DEFAULT_TARGETS.filter((t) => t.strategy === "preset").map((t) => t.preset).sort();
    assert.deepEqual(presets, ["email-address", "north-american-phone-number"]);
    const regexes = DEFAULT_TARGETS.filter((t) => t.strategy === "regex");
    assert.equal(regexes.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 2. piiValuesOf
// ---------------------------------------------------------------------------

describe("piiValuesOf", () => {
  test("returns the five shipment values for INVOICE", () => {
    const got = piiValuesOf(INVOICE);
    assert.deepEqual(got, [
      INVOICE.shipment.driverPhone,
      INVOICE.shipment.driverEmail,
      INVOICE.shipment.tractorVin,
      INVOICE.shipment.apContactEmail,
      INVOICE.shipment.apContactPhone,
    ]);
    assert.equal(got.length, 5);
  });

  test("returns [] for an invoice with no .shipment", () => {
    assert.deepEqual(piiValuesOf({}), []);
    assert.deepEqual(piiValuesOf({ shipment: null }), []);
    assert.deepEqual(piiValuesOf({ shipment: undefined }), []);
    assert.deepEqual(piiValuesOf({ invoiceNumber: "INV-1" }), []);
  });

  test("filters out falsy values within shipment", () => {
    const partial = {
      shipment: {
        driverPhone: "(201) 555-0142",
        driverEmail: "",
        tractorVin: null,
        apContactEmail: "ap@example.com",
        apContactPhone: undefined,
      },
    };
    assert.deepEqual(piiValuesOf(partial), ["(201) 555-0142", "ap@example.com"]);
  });
});

// ---------------------------------------------------------------------------
// 3-6. verifyRedaction
// ---------------------------------------------------------------------------

describe("verifyRedaction", () => {
  test("passes when no forbidden value appears and all expected tag sequences are found", async () => {
    // Parse text contains the Foxit signfield markers as the pipeline searches
    // for them: 'signfield:1:y' style substrings (Finding 5 handling).
    const parseText = "header signfield:1:y body signfield:2:y footer clean content";
    installMock({ parseText });

    const v = await verifyRedaction(new Uint8Array([1, 2, 3]), {
      mustBeAbsent: ["m.webb@acmefreight-drivers.example", "(201) 555-0142"],
      expectedTagSeqs: [1, 2],
    });
    assert.equal(v.ok, true);
    assert.deepEqual(v.leaked, []);
    assert.deepEqual(v.missingTags, []);
  });

  test("reports leaked values — case-insensitivity is REQUIRED", async () => {
    const leakedEmail = "m.webb@acmefreight-drivers.example";
    // Parser returned the value in different case — must still count as leaked
    const parseText = `document contains SECRET@EXAMPLE.COM and signfield:1:y and also ${leakedEmail.toUpperCase()} remains`;
    installMock({ parseText });

    const v = await verifyRedaction(new Uint8Array([1, 2, 3]), {
      mustBeAbsent: [leakedEmail, "SECRET@EXAMPLE.COM", "(201) 555-0142"],
      expectedTagSeqs: [1],
    });
    assert.equal(v.ok, false);
    // Both the lower-case forbidden value surviving as upper-case must be reported
    assert.ok(v.leaked.some((x) => x.toLowerCase() === leakedEmail.toLowerCase()), "lower-case value leaked as upper-case must be reported");
    assert.ok(v.leaked.some((x) => x.toLowerCase() === "secret@example.com"), "upper-case survivor must be reported case-insensitively");
    // The phone that is truly absent must NOT be reported as leaked
    assert.ok(!v.leaked.includes("(201) 555-0142"));
  });

  test("reports missingTags when an expected signfield sequence is absent", async () => {
    const parseText = "only signfield:1:y is present, party 2 tag was destroyed by redaction box";
    installMock({ parseText });

    const v = await verifyRedaction(new Uint8Array([1, 2, 3]), {
      mustBeAbsent: [],
      expectedTagSeqs: [1, 2],
    });
    assert.equal(v.ok, false);
    assert.deepEqual(v.missingTags, [2]);
    assert.deepEqual(v.leaked, []);
  });

  test("reports multiple missing tags", async () => {
    const parseText = "no tags at all in this document";
    installMock({ parseText });

    const v = await verifyRedaction(new Uint8Array([1]), {
      mustBeAbsent: [],
      expectedTagSeqs: [1, 2, 3],
    });
    assert.equal(v.ok, false);
    assert.deepEqual(v.missingTags, [1, 2, 3]);
  });

  test("returns ok:false with an error when the parse call fails (non-2xx) — must NOT report a false clean", async () => {
    installMock({ parseOk: false, parseStatus: 500, parseText: "internal error" });

    const v = await verifyRedaction(new Uint8Array([1, 2, 3]), {
      mustBeAbsent: ["secret@example.com"],
      expectedTagSeqs: [1],
    });
    assert.equal(v.ok, false);
    assert.ok(v.error, "a parse failure must surface an error");
    assert.match(v.error, /500|parse/i);
    // Must not claim clean: leaked/missingTags stay empty but ok is false
    assert.deepEqual(v.leaked, []);
    assert.deepEqual(v.missingTags, []);
  });

  test("parse transport error is surfaced as ok:false", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/extraction/parse")) throw new Error("ECONNRESET");
      return { ok: true, status: 200, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const v = await verifyRedaction(new Uint8Array([1]), { mustBeAbsent: [], expectedTagSeqs: [] });
    assert.equal(v.ok, false);
    assert.ok(v.error);
    assert.match(v.error, /transport/i);
  });

  test("parseDocumentText returns ok:false when NUTRIENT_DWS_EXTRACTION_API_KEY is missing", async () => {
    const saved = process.env.NUTRIENT_DWS_EXTRACTION_API_KEY;
    try {
      delete process.env.NUTRIENT_DWS_EXTRACTION_API_KEY;
      const r = await parseDocumentText(new Uint8Array([1, 2, 3]));
      assert.equal(r.ok, false);
      assert.match(r.error, /NUTRIENT_DWS_EXTRACTION_API_KEY/);
    } finally {
      process.env.NUTRIENT_DWS_EXTRACTION_API_KEY = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// 7-9. redactForSignature
// ---------------------------------------------------------------------------

describe("redactForSignature", () => {
  test("happy path returns ok:true, the APPLIED bytes, a summary string, and stagedBytes/appliedBytes counts", async () => {
    const parseText = "clean document signfield:1:y signfield:2:y no PII remains";
    installMock({ parseText });

    const mustBeAbsent = piiValuesOf(INVOICE);
    const expectedTagSeqs = [1, 2];

    const r = await redactForSignature(DOC, { mustBeAbsent, expectedTagSeqs });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    // Summary string is shown on the approval card — must mention counts
    assert.equal(typeof r.summary, "string");
    assert.match(r.summary, /target set\(s\) applied/);
    assert.match(r.summary, /verified absent/);
    assert.match(r.summary, /verified intact/);
    // Counts. Staging is OFF by default: it is a separately billed /build call
    // whose result is locally derivable, so the pipeline does not make it and
    // stagedBytes is null. appliedBytes always reflects a real call.
    assert.equal(r.stagedBytes, null);
    assert.equal(typeof r.appliedBytes, "number");
    assert.equal(r.appliedBytes, APPLIED_BYTES.length);
    assert.deepEqual(r.verified, { checked: mustBeAbsent.length, tags: expectedTagSeqs });
    assert.equal(r.staged.count, DEFAULT_TARGETS.length);
  });

  test("CRITICAL: the bytes returned on the happy path are the applied bytes and NOT the staged bytes", async () => {
    // The staged document still contains the PII (Finding 1) — it renders black
    // boxes but the text is extractable. Returning staged bytes would ship the
    // secret the caller asked to remove. The two mocked bodies are deliberately
    // distinguishable so this assertion is not vacuous.
    assert.notDeepEqual(STAGED_BYTES, APPLIED_BYTES, "test invariant: staged and applied bodies must differ");
    // Ensure the two markers are actually different content
    assert.notEqual(Buffer.from(STAGED_BYTES).toString(), Buffer.from(APPLIED_BYTES).toString());

    const parseText = "clean signfield:1:y signfield:2:y";
    installMock({ parseText, stageBytes: STAGED_BYTES, appliedBytes: APPLIED_BYTES });

    const r = await redactForSignature(DOC, { mustBeAbsent: [], expectedTagSeqs: [1, 2] });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("unreachable");
    assert.deepEqual(r.bytes, APPLIED_BYTES, "must return the APPLIED bytes");
    assert.ok(!r.bytes.every((b, i) => STAGED_BYTES[i] === b && r.bytes.length === STAGED_BYTES.length), "returned bytes must NOT equal staged bytes");
    // Also via the explicit counters
    assert.equal(r.appliedBytes, APPLIED_BYTES.length);
    assert.notEqual(r.appliedBytes, STAGED_BYTES.length, "staged and applied lengths must differ to prove the right document was returned");
    assert.deepEqual(Buffer.from(r.bytes).toString(), Buffer.from(APPLIED_BYTES).toString());
  });

  test("the default path makes exactly one billed /build call", async () => {
    // DWS bills roughly one credit per redaction action, so an unnecessary
    // staging call doubled the cost of every run. The inventory it used to
    // provide is computed locally. This test pins the saving: one /build call
    // (the apply) plus one /extraction/parse (the verification).
    let buildCalls = 0;
    let parseCalls = 0;
    installMock({ parseText: "clean signfield:1:y signfield:2:y" });
    const mocked = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("/build")) buildCalls += 1;
      if (u.includes("/extraction/parse")) parseCalls += 1;
      return mocked(url, init);
    };
    const r = await redactForSignature(DOC, { mustBeAbsent: [], expectedTagSeqs: [1, 2] });
    assert.equal(r.ok, true);
    assert.equal(buildCalls, 1, "exactly one billed /build call (the apply)");
    assert.equal(parseCalls, 1, "one verification read-back");

    // And with stageFirst it is two — the opt-in still works.
    buildCalls = 0;
    const r2 = await redactForSignature(DOC, { stageFirst: true, mustBeAbsent: [], expectedTagSeqs: [1, 2] });
    assert.equal(r2.ok, true);
    assert.equal(buildCalls, 2, "stageFirst adds the staging call back");
    assert.equal(r2.stagedBytes, STAGED_BYTES.length);
    // afterEach restores globalThis.fetch — no manual restore here, it raced.
  });

  test("returns ok:false with stage:'stage' when staging fails (stageFirst)", async () => {
    installMock({ failStage: true });
    // Staging only happens when explicitly requested — see the stageFirst option.

    const r = await redactForSignature(DOC, { stageFirst: true, mustBeAbsent: [], expectedTagSeqs: [1] });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.stage, "stage");
    assert.match(r.error, /stage failed/i);
  });

  test("returns ok:false with stage:'apply' when apply fails", async () => {
    installMock({ failApply: true });

    const r = await redactForSignature(DOC, { mustBeAbsent: [], expectedTagSeqs: [1] });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.stage, "apply");
    assert.match(r.error, /apply failed/i);
  });

  test("returns ok:false with stage:'verify' when verification finds a leak", async () => {
    const leaked = INVOICE.shipment.driverEmail;
    const parseText = `leaked content ${leaked} signfield:1:y`;
    installMock({ parseText });

    const r = await redactForSignature(DOC, {
      mustBeAbsent: [leaked],
      expectedTagSeqs: [1],
    });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.stage, "verify");
    assert.match(r.error, /survived redaction|value\(s\) survived/i);
  });

  test("returns ok:false with stage:'verify' when verification finds missing signature tags", async () => {
    const parseText = "clean but signfield:1:y only — tag 2 destroyed";
    installMock({ parseText });

    const r = await redactForSignature(DOC, { mustBeAbsent: [], expectedTagSeqs: [1, 2] });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.stage, "verify");
    assert.match(r.error, /signature tag/i);
  });

  test("returns ok:false with stage:'verify' when parse itself fails — must NOT report a false clean", async () => {
    installMock({ parseOk: false, parseStatus: 502, parseText: "bad gateway" });

    const r = await redactForSignature(DOC, { mustBeAbsent: [], expectedTagSeqs: [1] });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.stage, "verify");
    assert.match(r.error, /verification could not run|parse/i);
  });
});
