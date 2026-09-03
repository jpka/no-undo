/**
 * Tests for the Nutrient extraction routing adapter.
 *
 * Replays the committed live fixtures in docs/fixtures/ — does NOT call the
 * live API. The fixtures are real /extraction/extract responses for the same
 * generated messy invoice in structure, understand, and agentic mode, captured
 * by `node mcp/nutrient/extract-probe.mjs [--calibrate] --fixture` across three
 * live snapshots: Aug 20, Aug 29, and Sep 3, 2026 (docs/nutrient-stage-aug20.md,
 * docs/nutrient-calibration-sep3.md).
 *
 * The most important test in this file is the safety-property one: for every
 * mode, and every committed fixture for that mode (not just the newest — see
 * finding D), no field whose extracted value disagrees with the document may
 * be auto-approved. That property is the gate. The hand-written unit tests
 * above it exist to pin the individual rules the property depends on, so a
 * regression names the rule it broke instead of just failing the property.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  routeField,
  routeFields,
  iterCitations,
  summarizeRouting,
  thresholdsFor,
  THRESHOLDS,
  INVOICE_SCHEMA,
  ALWAYS_HUMAN_MATCHES,
} from "../mcp/nutrient/extraction-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "docs", "fixtures");

/**
 * Load every committed extract fixture for a mode, oldest first.
 *
 * Not just the newest: a threshold that only has to survive the latest
 * snapshot can quietly regress against an earlier one. Finding D
 * (docs/nutrient-calibration-sep3.md) is exactly that — the Sep 3 sample
 * auto-approved two wrong dollar amounts that the Aug 20/29 samples of the
 * same document correctly caught. Checking every committed fixture is what
 * would have caught that the moment the Sep 3 fixture was committed.
 * @param {string} mode
 * @returns {Array<{name: string, output: {data: any, metadata: any}}>}
 */
function fixturesForMode(mode) {
  const names = readdirSync(FIXTURES)
    .filter((f) => f.startsWith(`nutrient-extract-${mode}-`) && f.endsWith(".json"))
    .sort();
  assert.ok(names.length > 0, `no committed fixture for mode "${mode}"`);
  return names.map((name) => ({
    name,
    ...JSON.parse(readFileSync(join(FIXTURES, name), "utf8")),
  }));
}

/**
 * What the generated messy invoice actually says, per mcp/nutrient/messy-pdf.mjs.
 * Any auto-approved field that disagrees with this is a gate failure.
 * @type {Record<string, string|number>}
 */
const GROUND_TRUTH = {
  invoice_number: "INV-2026-0418",
  vendor_name: "ACME Freight Services",
  payer_name: "Kaniefsky Transport LLC",
  total_amount: 86.86,
  tax_amount: 5.87,
  "line_items[0].description": "Parcel 1",
  "line_items[0].quantity": 2,
  "line_items[0].unit_price": 14.5,
  "line_items[1].description": "Parcel 2",
  "line_items[1].quantity": 1,
  "line_items[1].unit_price": 39.99,
  "line_items[2].description": "Handling",
  "line_items[2].quantity": 3,
  "line_items[2].unit_price": 4,
};

/** A citation that clears every gate, as a base for targeted overrides. */
function passingCitation(overrides = {}) {
  return {
    match: "id_match",
    confidence: 0.99,
    confidenceComponents: { groundingScore: 0.99, source: "logprobs+margin" },
    recognitionScore: 0.99,
    pageNumber: 1,
    ...overrides,
  };
}

/** Route one synthetic field through the invoice thresholds. */
function routeOne(citation, value = "x", opts = {}) {
  const limits = thresholdsFor(opts.documentType ?? "invoice");
  return routeField(
    { field: "f", value, valuePresent: opts.valuePresent ?? true, citation },
    limits,
  );
}

// --- Match label is the primary signal --------------------------------------

describe("routeField: match label precedence", () => {
  test("a passing citation auto-approves", () => {
    assert.equal(routeOne(passingCitation()).route, "auto");
  });

  for (const label of ALWAYS_HUMAN_MATCHES) {
    test(`"${label}" routes to the human even at confidence 0.99`, () => {
      // The label is checked before any number is read. A confidently-wrong
      // fuzzy match is the exact case Nutrient warned about.
      const r = routeOne(passingCitation({ match: label }));
      assert.equal(r.route, "human");
      assert.match(r.reason, new RegExp(label));
    });
  }

  test("a missing match label routes to the human", () => {
    const c = passingCitation();
    delete c.match;
    const r = routeOne(c);
    assert.equal(r.route, "human");
    assert.match(r.reason, /no match label/i);
  });

  test("an unknown match label routes conservatively rather than optimistically", () => {
    const r = routeOne(passingCitation({ match: "some_future_label" }));
    assert.equal(r.route, "human");
    assert.match(r.reason, /unrecognized/i);
  });

  test("id_match_multiblock is eligible for the confidence tie-break", () => {
    assert.equal(routeOne(passingCitation({ match: "id_match_multiblock" })).route, "auto");
  });
});

// --- Confidence as secondary signal -----------------------------------------

describe("routeField: confidence tie-break", () => {
  test("below the document-type threshold routes to the human", () => {
    const r = routeOne(passingCitation({ confidence: 0.5 }));
    assert.equal(r.route, "human");
    assert.match(r.reason, /confidence 0\.500 below 0\.85/);
  });

  test("exactly at the threshold auto-approves", () => {
    assert.equal(routeOne(passingCitation({ confidence: 0.85 })).route, "auto");
  });

  test("absent confidence is not treated as low confidence", () => {
    // Absent means "no score available". Scoring it as 0 would refer every
    // unscored field and make the gate useless; scoring it as 1 would approve
    // blindly. Neither: hold it for review and say why.
    const c = passingCitation();
    delete c.confidence;
    const r = routeOne(c);
    assert.equal(r.route, "human");
    assert.match(r.reason, /no composite confidence/i);
    assert.equal(r.confidence, undefined);
  });
});

// --- Grounding and recognition vetoes ---------------------------------------

describe("routeField: component vetoes", () => {
  test("a low groundingScore vetoes an otherwise-passing field", () => {
    const r = routeOne(
      passingCitation({ confidenceComponents: { groundingScore: 0.2, source: "no-logprobs" } }),
    );
    assert.equal(r.route, "human");
    assert.match(r.reason, /groundingScore 0\.200 below 0\.7/);
  });

  test("a low recognitionScore vetoes a field every other signal cleared", () => {
    // This is finding B: on the live call total_amount came back id_match /
    // 0.970 / grounding 0.95 and was still the wrong number. recognitionScore
    // 0.678 was the only signal that knew.
    const r = routeOne(passingCitation({ recognitionScore: 0.678 }), 26.86);
    assert.equal(r.route, "human");
    assert.match(r.reason, /recognitionScore 0\.678 below 0\.9/);
  });

  test("absent recognitionScore routes to the human when the type requires it", () => {
    // Finding C: agentic mode never emits recognitionScore, and that silence
    // covered two wrong values. For invoices the gate demands confirmation.
    const c = passingCitation();
    delete c.recognitionScore;
    assert.equal(thresholdsFor("invoice").requireRecognition, true);
    const r = routeOne(c);
    assert.equal(r.route, "human");
    assert.match(r.reason, /no recognitionScore/i);
  });

  test("absent recognitionScore is tolerated for born-digital documents", () => {
    // No OCR stage means nothing could have been misread, so demanding an OCR
    // score there would refer every field for no reason.
    const c = passingCitation();
    delete c.recognitionScore;
    assert.equal(thresholdsFor("born_digital").requireRecognition, false);
    assert.equal(routeOne(c, "x", { documentType: "born_digital" }).route, "auto");
  });

  test("an absent groundingScore passes through, unlike an absent recognitionScore", () => {
    // The asymmetry, pinned. The match label already reports a grounding verdict,
    // so a missing grounding component is redundant; nothing reports OCR quality,
    // so a missing recognition score is a genuine blind spot.
    const noGrounding = passingCitation({ confidenceComponents: { source: "logprobs-only" } });
    assert.equal(routeOne(noGrounding).route, "auto", "absent grounding does not veto");

    const noRecognition = passingCitation();
    delete noRecognition.recognitionScore;
    assert.equal(routeOne(noRecognition).route, "human", "absent recognition does veto");
  });

  test("confidenceComponents missing entirely still auto-approves on a good label", () => {
    const c = passingCitation();
    delete c.confidenceComponents;
    assert.equal(routeOne(c).route, "auto");
  });
});

// --- The union walk ----------------------------------------------------------

describe("iterCitations: walks the union of data and metadata", () => {
  test("finds a not_found field that exists only in metadata", () => {
    // Finding A. This is the whole reason the walk is not data-driven: the API
    // omits ungrounded fields from output.data while keeping their citation in
    // output.metadata, so a data-driven walk never sees the single most
    // important routing signal.
    const fields = iterCitations(
      { present: "yes" },
      {
        present: passingCitation(),
        missing: { match: "not_found", source_bboxes: [] },
      },
    );
    const names = fields.map((f) => f.field);
    assert.deepEqual(names.sort(), ["missing", "present"]);
    const missing = fields.find((f) => f.field === "missing");
    assert.equal(missing.valuePresent, false);
    assert.equal(missing.citation.match, "not_found");
  });

  test("a sparse not_found citation is recognized as a leaf, not a nested mirror", () => {
    // {match, source_bboxes: []} has no confidence and no bbox. If the leaf
    // check required those, this node would be walked into as an object and the
    // field would vanish.
    const fields = iterCitations(undefined, { match: "not_found", source_bboxes: [] }, "f");
    assert.equal(fields.length, 1);
    assert.equal(fields[0].citation.match, "not_found");
  });

  test("mirrors nested objects and arrays with dotted and indexed paths", () => {
    const fields = iterCitations(
      { vendor: { city: "Bayonne" }, items: [{ qty: 2 }] },
      {
        vendor: { city: passingCitation() },
        items: [{ qty: passingCitation() }],
      },
    );
    assert.deepEqual(fields.map((f) => f.field).sort(), ["items[0].qty", "vendor.city"]);
  });

  test("null is a routed outcome, not a skipped one", () => {
    const fields = iterCitations({ f: null }, { f: passingCitation() });
    assert.equal(fields.length, 1);
    assert.equal(fields[0].value, null);
    assert.equal(fields[0].valuePresent, true);
  });

  test("a not_found field routes to the human and says the value was absent", () => {
    const r = routeFields(
      { present: "yes" },
      { present: passingCitation(), due_date: { match: "not_found", source_bboxes: [] } },
      { documentType: "invoice" },
    );
    const dd = r.fields.find((f) => f.field === "due_date");
    assert.equal(dd.route, "human");
    assert.match(dd.reason, /not_found/);
    assert.match(dd.reason, /absent from output\.data/);
  });
});

// --- Schema and thresholds --------------------------------------------------

describe("schema and thresholds", () => {
  test("the invoice schema stays inside the documented vocabulary", () => {
    // The endpoint rejects $ref, $defs, allOf/anyOf/oneOf, numeric ranges,
    // additionalProperties, conditionals, and any string format except "date".
    const banned = [
      "$ref",
      "$defs",
      "allOf",
      "anyOf",
      "oneOf",
      "minimum",
      "maximum",
      "maxLength",
      "additionalProperties",
      "if",
      "then",
      "else",
    ];
    const serialized = JSON.stringify(INVOICE_SCHEMA);
    for (const key of banned) {
      assert.ok(!serialized.includes(`"${key}"`), `schema must not use ${key}`);
    }
    assert.equal(INVOICE_SCHEMA.type, "object");
    assert.ok(serialized.length < 32 * 1024, "schema must stay under the 32KB limit");
  });

  test("the schema asks for two fields the test document does not contain", () => {
    // Deliberate: without these the not_found path is never exercised by a real
    // response, and the primary routing signal goes untested.
    assert.ok("due_date" in INVOICE_SCHEMA.properties);
    assert.ok("po_number" in INVOICE_SCHEMA.properties);
  });

  test("an unknown document type falls back to the strict DEFAULT", () => {
    const t = thresholdsFor("bill_of_lading_we_never_calibrated");
    assert.equal(t.documentType, "DEFAULT");
    assert.equal(t.confidence, THRESHOLDS.DEFAULT.confidence);
  });

  test("no threshold set claims to be calibrated yet", () => {
    // Flipping one of these to true is a claim that a representative sample was
    // actually run through --calibrate. Keep it honest.
    for (const [name, t] of Object.entries(THRESHOLDS)) {
      assert.equal(t.calibrated, false, `${name} claims calibration it has not had`);
    }
  });
});

// --- The property that matters ----------------------------------------------

describe("committed live fixtures", () => {
  for (const mode of ["structure", "understand", "agentic"]) {
    for (const { name, output } of fixturesForMode(mode)) {
      test(`${mode} (${name}): no wrong value is ever auto-approved`, () => {
        const routed = routeFields(output.data ?? {}, output.metadata ?? {}, {
          documentType: "invoice",
        });

        const escaped = routed.fields
          .filter((f) => f.route === "auto" && f.field in GROUND_TRUTH)
          .filter((f) => {
            const expected = GROUND_TRUTH[f.field];
            return typeof expected === "number"
              ? Math.abs(expected - Number(f.value)) > 1e-9
              : expected !== f.value;
          })
          .map((f) => `${f.field}: got ${JSON.stringify(f.value)}, document says ${JSON.stringify(GROUND_TRUTH[f.field])}`);

        assert.deepEqual(
          escaped,
          [],
          `${mode} (${name}) auto-approved ${escaped.length} field(s) that disagree with the document`,
        );
      });
    }
  }

  for (const { name, output } of fixturesForMode("understand")) {
    test(`understand (${name}): the two wrong totals never auto-approve`, () => {
      // The regression guard on findings B and D. Which signal catches them
      // is not pinned to a fixed value: Aug 20/29 caught both on the OCR
      // veto (recognitionScore ~0.57-0.68, well under the 0.9 floor); Sep 3
      // scored the same two wrong fields 0.834/0.842 — high enough that the
      // *old* 0.8 floor missed both. What must hold, on every snapshot, is
      // the outcome: route stays "human" and the reason names why.
      const routed = routeFields(output.data, output.metadata, { documentType: "invoice" });
      for (const field of ["total_amount", "tax_amount"]) {
        const f = routed.fields.find((x) => x.field === field);
        assert.equal(f.route, "human", `${field} must not auto-approve (${name})`);
        assert.match(
          f.reason,
          /recognitionScore/,
          `${field} must be caught by the OCR veto, not some other rule (${name})`,
        );
        // Every other signal cleared it in every snapshot so far, which is the point.
        assert.equal(f.match, "id_match");
        assert.ok(f.confidence > 0.9);
      }
    });
  }

  for (const { name, output } of fixturesForMode("agentic")) {
    test(`agentic (${name}): reports no OCR score at all, and is held for it`, () => {
      // The regression guard on finding C. Agentic was the most accurate mode
      // on the totals and the least inspectable overall.
      const routed = routeFields(output.data, output.metadata, { documentType: "invoice" });
      const summary = summarizeRouting(routed);
      assert.equal(
        summary.recognition.absent,
        summary.total,
        `agentic is expected to omit recognitionScore on every field (${name})`,
      );
      assert.equal(summary.auto, 0, `with no OCR signal, no invoice field may auto-approve (${name})`);
    });
  }

  // Named for the two modes it actually checks. structure mode is excluded on
  // purpose: it produced no citation for either field, so there is nothing to
  // assert about its not_found handling — which is itself the finding that
  // structure is unsuitable for schema extraction.
  for (const mode of ["understand", "agentic"]) {
    for (const { name, output } of fixturesForMode(mode)) {
      test(`${mode} (${name}): surfaces the two not_found fields`, () => {
        const routed = routeFields(output.data, output.metadata, { documentType: "invoice" });
        for (const field of ["due_date", "po_number"]) {
          const f = routed.fields.find((x) => x.field === field);
          assert.ok(f, `${mode} (${name}): ${field} must appear in the walk despite being absent from data`);
          assert.equal(f.match, "not_found");
          assert.equal(f.route, "human");
        }
      });
    }
  }

  for (const { name, output } of fixturesForMode("structure")) {
    test(`structure (${name}): refers everything, including fields it never scored`, () => {
      // The safe failure: a mode that produces little usable signal must not
      // produce many auto-approvals.
      const routed = routeFields(output.data, output.metadata, { documentType: "invoice" });
      const summary = summarizeRouting(routed);
      assert.equal(summary.auto, 0, `structure mode must not auto-approve on this document (${name})`);
      assert.ok(summary.total > 0, "the walk still finds fields to report");
    });
  }
});
