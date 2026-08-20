/**
 * Messy-document generator, shared by the Nutrient probes.
 *
 * A hand-built PDF: skewed text lines (simulating a wonky scan), gray noise
 * rectangles (stains), and a freehand signature polyline. OCR-reads with
 * imperfect, varied confidence — exactly the low-confidence, weakly-grounded
 * fields the human gate exists for.
 *
 * Extracted from extraction-probe.mjs (Gate 0) when extract-probe.mjs needed
 * the same document: the calibration comparison is only meaningful if both
 * endpoints see byte-identical input.
 *
 * Deliberate properties, and what each one is for:
 *   - "cr8te a p9ckng sl1p" — OCR-hostile glyphs, drives low recognitionScore.
 *   - Rotated text matrices    — scan skew, degrades grounding.
 *   - No due date, no PO number anywhere on the page — a schema asking for
 *     them must come back `not_found`, which is the routing signal we most
 *     need to see exercised.
 *   - Handwritten red annotations — printed-style handwriting, the case the
 *     Nutrient docs say separates `understand` from `agentic`.
 */

/**
 * Generate a deterministic single-page PDF with skewed lines, stains, and a
 * freehand signature, for exercising extraction confidence scoring.
 * @returns {string} PDF bytes as a latin1-encodable string
 */
export function messyPdf() {
  const content = [];
  const push = (s) => content.push(s);

  // A freehand-style "signature" as a long polyline, in red ink.
  let sig = "0.8 0.1 0.1 RG 1.5 w\n";
  let x = 320;
  let y = 150;
  for (let i = 0; i < 24; i++) {
    sig += `q 1 0 0 1 ${x} ${y} m ${x + 5} ${y + (i % 2 ? -4 : 4)} l ${x + 9} ${y - 2} l ${x + 13} ${y + (i % 2 ? 5 : -5)} l S Q\n`;
    x += 13;
    y += (i % 3 === 0 ? 3 : -2);
  }

  // Noise "stains": light gray rectangles at fixed spots.
  for (const [nx, ny, nw, nh] of [
    [40, 620, 90, 8], [120, 400, 40, 12], [420, 300, 70, 10], [260, 230, 50, 14],
  ]) {
    push(`q 0.88 g ${nx} ${ny} ${nw} ${nh} re f Q\n`);
  }

  // Title.
  push("BT /F1 22 Tf 0 0 0 rg 40 700 Td (ACME Freight Services - Invoice #INV-2026-0418) Tj ET\n");
  // A "date stamped" line with OCR-hostile glyph substitutions.
  push("BT /F1 12 Tf 0 0 0 rg 1 0 0 1 40 670 Tm (Received  Aug 18 2026   cr8te a p9ckng sl1p) Tj ET\n");
  // Body lines, each with a small rotation to simulate scan skew.
  const lines = [
    "Payer:     Kaniefsky Transport LLC, 4th Ave, Brooklyn NY",
    "Vendor:    ACME Freight Services - terminal 3, Bayonne NJ",
    "Item       Qty   Unit price      Total",
    "Parcel 1   2      $14.50          $29.00",
    "Parcel 2   1      $39.99          $39.99",
    "Handling   3      $4.00           $12.00",
    "Subtotal                     $80.99",
    "Tax (7.25%)                    $5.87",
    "Total due                     $86.86",
  ];
  let ty = 620;
  for (const [i, ln] of lines.entries()) {
    const rot = (i % 2 === 0 ? 0.015 : -0.02) * (i % 4 === 0 ? -1 : 1);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    push(`BT /F1 ${i < 3 ? 13 : 11} Tf 0 0 0 rg ${c} ${s} ${-s} ${c} 40 ${ty} Tm (${ln}) Tj ET\n`);
    ty -= 34;
  }
  // Handwritten-style annotations next to the total.
  push("BT /F1 10 Tf 0.8 0.1 0.1 rg 0.995 0.02 -0.02 0.995 300 300 Tm (plz call before delivery) Tj ET\n");
  push("BT /F1 10 Tf 0.8 0.1 0.1 rg 0.995 -0.02 0.02 0.995 300 280 Tm (no signature unless ok) Tj ET\n");
  push(sig);

  const stream = content.join("");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return out;
}
