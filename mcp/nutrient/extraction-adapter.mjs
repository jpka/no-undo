/**
 * Nutrient DWS extraction routing adapter.
 *
 * Turns a `/extraction/extract` response into a routing decision per field:
 * auto-approve, or stop and ask the human. This is the Nutrient half of the
 * gate — the same approval UI the eSign send uses (mcp/foxit/esign-adapter.mjs)
 * reviews these decisions, which is the design argument: one gate, two
 * irreversible-adjacent decisions.
 *
 * THE ROUTING RULE, and why it is shaped this way
 * -----------------------------------------------
 * Per Nutrient's own guidance (docs/nutrient-support-aug20.md, and the public
 * citations-and-confidence guide), the per-field **match label is the primary
 * signal** and the composite confidence is a secondary tie-breaker:
 *
 *   fuzzy_match       → human, unconditionally. The value is close to but not
 *                       identical to the source text.
 *   not_found         → human, unconditionally. The API could not ground the
 *                       value to any source location at all.
 *   id_match_partial  → human. Only some cited source blocks resolved.
 *   id_match          → confidence tie-break.
 *   id_match_multiblock → confidence tie-break.
 *   (label missing)   → human. An ungraded field is not an approved field.
 *
 * Three deliberate decisions that are easy to get wrong:
 *
 * 1. **Absent confidence is not low confidence.** The `confidence` field is
 *    omitted when the engine produced no composite score. Treating `undefined`
 *    as 0 would route every unscored field to the human and make the gate
 *    useless; treating it as 1 would auto-approve blindly. We keep the match
 *    label as the decision and record `confidenceAbsent` so calibration can
 *    see how often it happens.
 *
 * 2. **Thresholds are per document type, never global.** The score is relative
 *    and uncalibrated — 0.82 on an invoice is not 0.82 on a bill of lading. A
 *    single global cutoff behaves inconsistently, so callers pass a
 *    `documentType` and get that type's calibrated threshold. `DEFAULT` is
 *    explicitly marked uncalibrated and is intentionally strict.
 *
 * 3. **groundingScore can veto an otherwise-passing field.** A field can clear
 *    the composite threshold while being weakly grounded — "found in the
 *    document" vs "inferred". When `confidenceComponents.groundingScore` is
 *    present and below the grounding floor, the field goes to the human even
 *    though the composite passed.
 *
 * TWO THINGS THE LIVE API TAUGHT US (Aug 20, docs/nutrient-extract-aug20.md)
 * -------------------------------------------------------------------------
 * A. **`not_found` fields are absent from `output.data` but present in
 *    `output.metadata`.** A field the API could not ground is simply omitted
 *    from the data object, while its citation — carrying `match: "not_found"` —
 *    still appears in the metadata mirror. So walking `data` and reading
 *    `metadata` alongside it, which is what Nutrient's own documented
 *    `iter_citations` example does, never visits the `not_found` fields at all.
 *    The single most important routing signal is the one that walk cannot see.
 *    We therefore walk the **union** of both structures, keyed on metadata for
 *    scalars, and mark a field `valuePresent: false` when it is missing from
 *    data. A required field that came back `not_found` is a hard human stop.
 *
 * B. **`recognitionScore` is load-bearing, not decorative, and is the only
 *    signal that catches a confidently-wrong OCR read.** On the messy test
 *    invoice, understand mode returned `total_amount: 26.86` where the document
 *    reads $86.86, and `tax_amount: 5.27` where it reads $5.87. Both came back
 *    `match: "id_match"`, `confidence: 0.970`, `groundingScore: 0.95` — every
 *    primary and secondary signal said auto-approve, on two wrong numbers. The
 *    only signal that flagged them was `recognitionScore`: 0.678 and 0.569, the
 *    two lowest on the page. The grounding signals are measuring "is this value
 *    where the model says it is", which is true; they cannot measure "did OCR
 *    read the glyphs correctly", which is what actually failed. So the router
 *    applies a `recognition` floor as a hard veto. This is exactly the
 *    "confidently wrong even in the highest-accuracy mode" case Nutrient warned
 *    about, reproduced on the first live call, and it is the strongest possible
 *    argument for the gate existing at all.
 *
 * C. **Agentic mode is the most dangerous mode for this gate, not the safest.**
 *    On the same document, agentic got the totals right (86.86, 5.87) and then
 *    misparsed the line-item table instead: "Parcel 1" and "Parcel 2" became
 *    description "Parcel" with quantities 1 and 2, silently shifting the row
 *    number into the quantity column. Two fields still wrong — just different
 *    ones. And because agentic is VLM-augmented, the API omits
 *    `recognitionScore` entirely for its extractions (documented: omitted for
 *    born-digital text, `not_found`, and VLM-only). So on agentic every
 *    grounding signal reads 0.95–0.97, the OCR veto has nothing to bite on, and
 *    14 of 16 fields auto-approve including the two wrong ones. A higher-cost,
 *    higher-accuracy mode produced *fewer usable safety signals*.
 *
 *    That is why `THRESHOLDS` carries `requireRecognition` per document type. In
 *    modes that report no OCR score, the absence is not evidence of quality, and
 *    for a high-stakes field it must not be read as a pass. Raising accuracy is
 *    not the same as earning trust, and the gate has to hold the distinction.
 *
 * This module is pure: no network, no clock, no filesystem. That is what makes
 * it testable against committed fixtures.
 */

// --- Match labels -----------------------------------------------------------

/** Labels that always route to the human, regardless of any confidence score. */
export const ALWAYS_HUMAN_MATCHES = Object.freeze([
  "fuzzy_match",
  "not_found",
  "id_match_partial",
]);

/** Labels considered grounded enough for a confidence tie-break to decide. */
export const TIEBREAK_MATCHES = Object.freeze(["id_match", "id_match_multiblock"]);

// --- Thresholds -------------------------------------------------------------

/**
 * Per-document-type calibrated thresholds.
 *
 * `confidence` — composite score at or above which a well-grounded field may
 * auto-approve. `grounding` — floor on `confidenceComponents.groundingScore`;
 * below it the value looks inferred rather than read, so it goes to the human.
 * `recognition` — floor on the field-level `recognitionScore` (OCR quality).
 *
 * The `recognition` floor is the one that earns its keep. See finding B in the
 * header: it is the only signal that caught two confidently-wrong OCR reads
 * that every other signal cleared. It is set above the observed 0.678 of the
 * worst wrong field on purpose.
 *
 * `requireRecognition` decides what an *absent* `recognitionScore` means. The
 * API omits it for born-digital text, `not_found`, and VLM-only (agentic)
 * extractions, so absence genuinely means "not measured" — but see finding C:
 * on agentic, absence covered two wrong values that nothing else flagged. So
 * this is a per-document-type policy call, not a universal rule:
 *
 *   false — absent is tolerated. Right for born-digital documents, where there
 *           is no OCR step that could have misread anything.
 *   true  — absent routes to the human. Right for scanned or high-stakes
 *           documents, and the correct setting when running agentic mode: if
 *           the mode will not tell you whether the text was read correctly,
 *           a human confirms it.
 *
 * `invoice` sets it true because the invoice path is the one feeding the
 * signature gate, and an unverifiable total is exactly what must not sail
 * through.
 *
 * CALIBRATION STATUS: these are starting points, not calibrated values. Run
 * `node mcp/nutrient/extract-probe.mjs --calibrate` against a representative
 * sample per document type and set each entry from the resulting table. Until
 * a type has been through that, it inherits DEFAULT, which is strict on
 * purpose: an uncalibrated threshold should over-refer to the human, not
 * under-refer.
 *
 * @type {Record<string, {confidence: number, grounding: number, recognition: number, requireRecognition: boolean, calibrated: boolean}>}
 */
export const THRESHOLDS = {
  DEFAULT: {
    confidence: 0.9,
    grounding: 0.7,
    recognition: 0.8,
    requireRecognition: true,
    calibrated: false,
  },
  invoice: {
    confidence: 0.85,
    grounding: 0.7,
    recognition: 0.8,
    requireRecognition: true,
    calibrated: false,
  },
  // Born-digital documents have no OCR stage, so an absent recognitionScore
  // carries no risk and demanding one would refer every field pointlessly.
  born_digital: {
    confidence: 0.9,
    grounding: 0.7,
    recognition: 0.8,
    requireRecognition: false,
    calibrated: false,
  },
};

/**
 * Resolve the threshold set for a document type.
 * @param {string} [documentType]
 * @returns {{confidence: number, grounding: number, recognition: number, requireRecognition: boolean, calibrated: boolean, documentType: string}}
 */
export function thresholdsFor(documentType) {
  const key = documentType && THRESHOLDS[documentType] ? documentType : "DEFAULT";
  return { ...THRESHOLDS[key], documentType: key };
}

// --- Schema -----------------------------------------------------------------

/**
 * Invoice schema for the probe and the tests.
 *
 * `due_date` and `po_number` are absent from the generated messy document on
 * purpose: asking for them forces the API to emit `not_found`, so the
 * unconditional-human path is exercised by a real response rather than assumed.
 *
 * Stays inside the documented schema vocabulary — no $ref, no allOf, no
 * numeric ranges, no additionalProperties, and `format: "date"` is the only
 * string format the endpoint accepts.
 */
export const INVOICE_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    invoice_number: { type: "string", description: "The invoice identifier, e.g. INV-2026-0418" },
    vendor_name: { type: "string", description: "The company issuing the invoice" },
    payer_name: { type: "string", description: "The company being billed" },
    total_amount: {
      type: "number",
      description: "The final total due, after tax and discounts",
    },
    tax_amount: { type: "number", description: "The tax charged on this invoice" },
    due_date: {
      type: "string",
      format: "date",
      description: "The payment due date, if the invoice states one",
    },
    po_number: {
      type: "string",
      description: "The purchase order number, if the invoice references one",
    },
    line_items: {
      type: "array",
      description: "One entry per row in the line-item table",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: { type: "integer" },
          unit_price: { type: "number" },
        },
        required: ["description"],
      },
    },
  },
  required: ["invoice_number", "total_amount"],
});

// --- Field walking ----------------------------------------------------------

/**
 * @typedef {Object} FieldCitation
 * @property {string} [match]
 * @property {number} [confidence]
 * @property {Record<string, number|string>} [confidenceComponents]
 * @property {number} [recognitionScore]
 * @property {number} [pageNumber]
 * @property {{x: number, y: number, width: number, height: number}} [bbox]
 */

/**
 * @typedef {Object} RoutedField
 * @property {string} field       Dotted path, e.g. "line_items[0].quantity"
 * @property {unknown} value
 * @property {boolean} valuePresent  False when the field is absent from output.data
 * @property {string|undefined} match
 * @property {number|undefined} confidence
 * @property {Record<string, number|string>|undefined} confidenceComponents
 * @property {number|undefined} recognitionScore
 * @property {number|undefined} pageNumber
 * @property {"auto"|"human"} route
 * @property {string} reason
 */

/** Keys that identify a metadata node as a leaf citation rather than a nested mirror. */
const CITATION_KEYS = ["match", "confidence", "bbox", "confidenceComponents", "source_bboxes"];

/**
 * Is this metadata node a leaf citation rather than a nested mirror?
 *
 * `output.metadata` mirrors `output.data`, so at a scalar leaf the metadata node
 * is the citation object itself, while a nested object's metadata node is
 * another mirror. Distinguish by the presence of citation keys. A `not_found`
 * citation can be as sparse as `{match, source_bboxes: []}`, so the check has
 * to accept any one of the citation keys rather than requiring `confidence`.
 * @param {unknown} node
 * @returns {boolean}
 */
function isCitation(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  return CITATION_KEYS.some((k) => k in node);
}

/** @param {unknown} v */
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Walk `data` and `metadata` together, yielding one entry per scalar leaf.
 *
 * Walks the UNION of the two structures rather than just `data`. This is
 * finding A from the header and it is not a stylistic choice: a `not_found`
 * field is omitted from `output.data` entirely while its citation remains in
 * `output.metadata`, so a data-driven walk silently drops every ungrounded
 * field — the exact fields the gate exists to catch. Nutrient's own documented
 * `iter_citations` example has this blind spot.
 *
 * A leaf is any non-object, non-array value, including `null`, which is a real
 * extraction outcome and must still be routed rather than skipped.
 * @param {unknown} data
 * @param {unknown} metadata
 * @param {string} [path]
 * @returns {Array<{field: string, value: unknown, valuePresent: boolean, citation: FieldCitation}>}
 */
export function iterCitations(data, metadata, path = "") {
  /** @type {Array<{field: string, value: unknown, valuePresent: boolean, citation: FieldCitation}>} */
  const out = [];

  // A leaf citation ends the walk even when the value side is missing, which is
  // precisely the not_found case.
  if (isCitation(metadata)) {
    out.push({
      field: path,
      value: data,
      valuePresent: data !== undefined,
      citation: /** @type {FieldCitation} */ (metadata),
    });
    return out;
  }

  if (isPlainObject(data) || isPlainObject(metadata)) {
    // Union of keys, data order first so the report reads in schema order and
    // metadata-only keys (the not_found fields) follow rather than interleave.
    const keys = [
      ...Object.keys(isPlainObject(data) ? data : {}),
      ...Object.keys(isPlainObject(metadata) ? metadata : {}).filter(
        (k) => !isPlainObject(data) || !(k in data),
      ),
    ];
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      out.push(
        ...iterCitations(
          isPlainObject(data) ? data[key] : undefined,
          isPlainObject(metadata) ? metadata[key] : undefined,
          childPath,
        ),
      );
    }
    return out;
  }

  if (Array.isArray(data) || Array.isArray(metadata)) {
    const len = Math.max(
      Array.isArray(data) ? data.length : 0,
      Array.isArray(metadata) ? metadata.length : 0,
    );
    for (let i = 0; i < len; i++) {
      out.push(
        ...iterCitations(
          Array.isArray(data) ? data[i] : undefined,
          Array.isArray(metadata) ? metadata[i] : undefined,
          `${path}[${i}]`,
        ),
      );
    }
    return out;
  }

  out.push({ field: path, value: data, valuePresent: data !== undefined, citation: {} });
  return out;
}

// --- Routing ----------------------------------------------------------------

/**
 * Decide a single field's route.
 *
 * Order matters. The match label is checked before any number is looked at, so
 * a confidently-wrong `fuzzy_match` at confidence 0.99 still goes to the human.
 * The recognition veto is checked last but is absolute: a field can satisfy
 * every grounding signal and still be a misread, which is exactly what the live
 * API did on the first call (finding B in the header).
 * @param {{field: string, value: unknown, valuePresent: boolean, citation: FieldCitation}} entry
 * @param {{confidence: number, grounding: number, recognition: number}} limits
 * @returns {RoutedField}
 */
export function routeField(entry, limits) {
  const { field, value, valuePresent, citation } = entry;
  const match = typeof citation.match === "string" ? citation.match : undefined;
  const confidence = typeof citation.confidence === "number" ? citation.confidence : undefined;
  const components =
    citation.confidenceComponents && typeof citation.confidenceComponents === "object"
      ? citation.confidenceComponents
      : undefined;
  const grounding =
    typeof components?.groundingScore === "number" ? components.groundingScore : undefined;
  const recognition =
    typeof citation.recognitionScore === "number" ? citation.recognitionScore : undefined;

  /** @param {"auto"|"human"} route @param {string} reason */
  const decide = (route, reason) => ({
    field,
    value,
    valuePresent,
    match,
    confidence,
    confidenceComponents: components,
    recognitionScore: recognition,
    pageNumber: typeof citation.pageNumber === "number" ? citation.pageNumber : undefined,
    route,
    reason,
  });

  // 1. No label at all — an ungraded field is not an approved field.
  if (!match) {
    return decide("human", "no match label on the citation; cannot be auto-approved");
  }

  // 2. Labels that route to the human no matter what the score says.
  if (ALWAYS_HUMAN_MATCHES.includes(match)) {
    const absent = valuePresent ? "" : " (field absent from output.data)";
    return decide("human", `match label "${match}" always routes to review${absent}`);
  }

  // 3. An unrecognized label is treated conservatively rather than optimistically.
  if (!TIEBREAK_MATCHES.includes(match)) {
    return decide("human", `unrecognized match label "${match}"; routing conservatively`);
  }

  // 4. A grounded label on a field that produced no value is contradictory
  //    enough to be worth a human look rather than a silent pass.
  if (!valuePresent) {
    return decide("human", `label "${match}" but no value present in output.data`);
  }

  // 5. Grounded label, but no composite score. Absent is NOT low: the label
  //    already says the value was grounded to a source block, so we hold it for
  //    review rather than inventing a number for it.
  if (confidence === undefined) {
    return decide("human", `grounded (${match}) but no composite confidence was produced`);
  }

  // 6. Composite tie-break.
  if (confidence < limits.confidence) {
    return decide(
      "human",
      `confidence ${confidence.toFixed(3)} below ${limits.confidence} for this document type`,
    );
  }

  // 7. Grounding veto: the composite passed, but the value looks inferred
  //    rather than read off the page.
  if (grounding !== undefined && grounding < limits.grounding) {
    return decide(
      "human",
      `groundingScore ${grounding.toFixed(3)} below ${limits.grounding} — value looks inferred`,
    );
  }

  // 8. Recognition veto. The grounding signals answer "is the value where the
  //    model says it is", which can be true of a misread. This one answers "was
  //    the text read correctly", and it is the only signal that caught the two
  //    wrong totals on the live call.
  if (recognition !== undefined && recognition < limits.recognition) {
    return decide(
      "human",
      `recognitionScore ${recognition.toFixed(3)} below ${limits.recognition} — OCR may have misread this value`,
    );
  }

  // 9. Absent recognition score. Whether this is acceptable is a per-document-
  //    type policy call (finding C): on agentic mode the score is never emitted,
  //    and that silence hid two wrong values. Where the type demands it, an
  //    unverifiable read is not an approved read.
  if (recognition === undefined && limits.requireRecognition) {
    return decide(
      "human",
      "no recognitionScore reported (VLM-only or unmeasured) and this document " +
        "type requires OCR confirmation",
    );
  }

  return decide(
    "auto",
    `${match} with confidence ${confidence.toFixed(3)} at or above ${limits.confidence}`,
  );
}

/**
 * Route every field in an extract response.
 * @param {unknown} data      output.data
 * @param {unknown} metadata  output.metadata
 * @param {{documentType?: string}} [options]
 * @returns {{fields: RoutedField[], limits: ReturnType<typeof thresholdsFor>, needsReview: RoutedField[]}}
 */
export function routeFields(data, metadata, options = {}) {
  const limits = thresholdsFor(options.documentType);
  const fields = iterCitations(data, metadata).map((entry) => routeField(entry, limits));
  return { fields, limits, needsReview: fields.filter((f) => f.route === "human") };
}

/**
 * Aggregate a routing result into the numbers the calibration table prints.
 * @param {{fields: RoutedField[]}} routed
 */
export function summarizeRouting(routed) {
  const { fields } = routed;
  /** @type {Record<string, number>} */
  const byMatch = {};
  for (const f of fields) {
    const key = f.match ?? "(none)";
    byMatch[key] = (byMatch[key] ?? 0) + 1;
  }
  const scores = fields
    .map((f) => f.confidence)
    .filter((c) => typeof c === "number")
    .sort((a, b) => a - b);
  const recog = fields
    .map((f) => f.recognitionScore)
    .filter((c) => typeof c === "number")
    .sort((a, b) => a - b);
  return {
    total: fields.length,
    auto: fields.filter((f) => f.route === "auto").length,
    human: fields.filter((f) => f.route === "human").length,
    byMatch,
    confidence: {
      min: scores.length ? scores[0] : null,
      median: scores.length ? scores[Math.floor(scores.length / 2)] : null,
      max: scores.length ? scores[scores.length - 1] : null,
      absent: fields.length - scores.length,
    },
    recognition: {
      min: recog.length ? recog[0] : null,
      median: recog.length ? recog[Math.floor(recog.length / 2)] : null,
      absent: fields.length - recog.length,
    },
    // Fields the human must look at that would have been auto-approved on the
    // grounding signals alone. This is the count that justifies the OCR veto.
    savedByRecognition: fields.filter((f) => f.reason.startsWith("recognitionScore")).length,
  };
}
