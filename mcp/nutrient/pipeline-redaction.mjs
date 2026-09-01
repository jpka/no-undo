/**
 * Redaction for the single pipeline: stage → apply → **verify**.
 *
 * This is the Nutrient half of the prompt "redact the PII, and send it to Alice
 * and Bob for signature". It runs after Foxit assembles the document and before
 * the approval gate, so the human reviews the document that will actually be
 * sent — redacted, digest computed, signature fields intact.
 *
 * The verify step is not defensive programming, it is a finding. Probed
 * Sep 1, 2026 (docs/nutrient-redaction-sep1.md):
 *
 *   - `preset: "vin"` returns HTTP 200 and a valid PDF and redacts nothing.
 *     A caller that trusts the status code ships the VIN.
 *   - A redaction box that overlaps a Foxit Text Tag destroys the tag. The
 *     document still looks fine; the gateway then refuses the send.
 *   - The *staged* document keeps every value in extractable form while
 *     rendering black boxes over them. It must never be the document that ships.
 *
 * So the contract here is: nothing leaves this module unless the redacted bytes
 * have been re-read and every target value is confirmed gone and every expected
 * signature tag confirmed present. Anything else fails the run — the caller
 * aborts before a draft folder exists, rather than degrading to an unredacted
 * send on a prompt that asked for redaction.
 */

import { stageRedactions, applyRedactions, describeTarget } from "./redaction-adapter.mjs";

const PARSE_URL = process.env.NUTRIENT_PARSE_URL ?? "https://api.nutrient.io/extraction/parse";
const API_VERSION = "2026-05-25";

/**
 * Default redaction targets for the freight-invoice demo.
 *
 * `email-address` and `north-american-phone-number` are presets confirmed to
 * both accept AND match. The VIN is a regex rather than the `vin` preset: the
 * preset accepts and does not match (Finding 4). The 17-character class
 * excludes I, O and Q, which the VIN standard forbids.
 * @type {import("./redaction-adapter.mjs").RedactionTarget[]}
 */
export const DEFAULT_TARGETS = Object.freeze([
  { strategy: "preset", preset: "email-address" },
  { strategy: "preset", preset: "north-american-phone-number" },
  { strategy: "regex", regex: "[A-HJ-NPR-Z0-9]{17}" },
]);

/**
 * Read a PDF's text back via /extraction/parse.
 *
 * Verification has to read the document the way a recipient's tooling would,
 * not scan the raw bytes: text in a `pdf_from_html` PDF lives in FlateDecode
 * streams under subset-font encoding, where neither a byte scan nor stream
 * inflation recovers it (Finding 5).
 * @param {Uint8Array} bytes
 * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
 */
export async function parseDocumentText(bytes) {
  const key = process.env.NUTRIENT_DWS_EXTRACTION_API_KEY;
  if (!key) return { ok: false, error: "NUTRIENT_DWS_EXTRACTION_API_KEY is not set" };
  const body = new FormData();
  body.append("file", new Blob([bytes]), "document.pdf");
  body.append("instructions", JSON.stringify({ parseConfig: { mode: "structure" } }));
  let res;
  try {
    res = await fetch(PARSE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "x-nutrient-api-version": API_VERSION },
      body,
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
  } catch (e) {
    return { ok: false, error: `parse transport error: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, error: `parse HTTP ${res.status}: ${text.slice(0, 200)}` };
  return { ok: true, text };
}

/**
 * Confirm a redacted document is actually redacted and still signable.
 *
 * @param {Uint8Array} bytes redacted document
 * @param {{mustBeAbsent: string[], expectedTagSeqs: number[]}} expectations
 * @returns {Promise<{ok: boolean, leaked: string[], missingTags: number[], error?: string}>}
 */
export async function verifyRedaction(bytes, { mustBeAbsent, expectedTagSeqs }) {
  const parsed = await parseDocumentText(bytes);
  if (!parsed.ok) return { ok: false, leaked: [], missingTags: [], error: parsed.error };
  const text = parsed.text;

  // Values that must be gone. Compared case-insensitively: a redaction that
  // left a differently-cased copy behind has still leaked the value.
  const leaked = mustBeAbsent.filter((v) => v && text.toLowerCase().includes(v.toLowerCase()));

  // Signature tags that must have survived. Foxit converts `${signfield:N:y:…}`
  // into a real field at createfolder time; if redaction destroyed the tag the
  // gateway refuses the send with "Please assign a signature field".
  const presentSeqs = new Set();
  for (const m of text.matchAll(/signfield:(\d+):y/g)) presentSeqs.add(Number(m[1]));
  const missingTags = expectedTagSeqs.filter((n) => !presentSeqs.has(n));

  return { ok: leaked.length === 0 && missingTags.length === 0, leaked, missingTags };
}

/**
 * Collect the PII values the fixture puts in the document, so verification has
 * concrete strings to assert the absence of rather than trusting a preset name.
 * @param {object} invoice
 * @returns {string[]}
 */
export function piiValuesOf(invoice) {
  const s = invoice?.shipment;
  if (!s) return [];
  return [s.driverPhone, s.driverEmail, s.tractorVin, s.apContactEmail, s.apContactPhone].filter(Boolean);
}

/**
 * Stage, apply, and verify. Returns redacted bytes only on a verified result.
 *
 * @param {Uint8Array} docBytes assembled, signature-tagged document
 * @param {object} options
 * @param {import("./redaction-adapter.mjs").RedactionTarget[]} [options.targets]
 * @param {string[]} options.mustBeAbsent concrete values that must not survive
 * @param {number[]} options.expectedTagSeqs signature tag sequences that must survive
 * @returns {Promise<{ok: true, bytes: Uint8Array, summary: string, staged: {count: number, targets: string[]}, verified: {checked: number, tags: number[]}, stagedBytes: number, appliedBytes: number}
 *                  | {ok: false, error: string, stage: "stage"|"apply"|"verify"}>}
 */
export async function redactForSignature(docBytes, options) {
  const targets = options.targets ?? DEFAULT_TARGETS;
  const { mustBeAbsent, expectedTagSeqs } = options;

  // 1. Stage. Reversible, and its only job here is the reviewable inventory of
  //    what the detector matched. The staged BYTES are deliberately discarded:
  //    they still contain every value (Finding 1) and must never reach a signer.
  const staged = await stageRedactions(docBytes, targets, { fileName: "invoice.pdf" });
  if (!staged.ok) {
    return { ok: false, error: `stage failed: ${staged.error}`, stage: "stage" };
  }

  // 2. Apply. Destroys content under every mark.
  const applied = await applyRedactions(docBytes, targets, { fileName: "invoice.pdf" });
  if (!applied.ok) {
    return { ok: false, error: `apply failed: ${applied.error}`, stage: "apply" };
  }

  // 3. Verify against the document that will actually be sent.
  const v = await verifyRedaction(applied.bytes, { mustBeAbsent, expectedTagSeqs });
  if (!v.ok) {
    const why = v.error
      ? `verification could not run: ${v.error}`
      : [
          v.leaked.length ? `${v.leaked.length} value(s) survived redaction` : null,
          v.missingTags.length ? `signature tag(s) destroyed: party ${v.missingTags.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; ");
    return { ok: false, error: why, stage: "verify" };
  }

  // Labelled "Nutrient redaction" on the approval card — no prefix here.
  const summary =
    `${staged.staged.count} target set(s) applied ` +
    `(${staged.staged.targets.join("; ")}) — ` +
    `${mustBeAbsent.length} value(s) verified absent from the outgoing document, ` +
    `${expectedTagSeqs.length} signature field(s) verified intact`;

  return {
    ok: true,
    bytes: applied.bytes,
    summary,
    staged: staged.staged,
    verified: { checked: mustBeAbsent.length, tags: expectedTagSeqs },
    stagedBytes: staged.bytes.length,
    appliedBytes: applied.bytes.length,
  };
}
