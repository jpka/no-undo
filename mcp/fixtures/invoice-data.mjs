/**
 * Single shared invoice fixture for the No Undo demo.
 *
 * One source of truth for every figure the demo turns on — the messy PDF
 * the Nutrient stage extracts from AND the PDF the Foxit stage assembles
 * for signature. If these diverge, the video tells two unrelated stories
 * (extraction misreads one document, a different one gets signed). If they
 * match, it's one coherent run.
 *
 * Ground truth for test/extraction-adapter.test.mjs GROUND_TRUTH.
 *
 * `shipment` carries the third-party PII a real freight invoice carries and
 * that must NOT reach the signing parties: the driver's mobile and email, the
 * tractor VIN, and the payer's accounts-payable contact. These are the
 * redaction targets — deliberately NOT the signers' own addresses, which are
 * pointless to redact from a document those same people are being asked to
 * sign, and whose redaction boxes overlap the Foxit signature tags and destroy
 * them (probed Sep 1, 2026 — see docs/nutrient-redaction-sep1.md).
 *
 * All values are synthetic: 555-01xx numbers and .example domains are reserved
 * for documentation and cannot route to a real person.
 */

export const INVOICE = {
  invoiceNumber: "INV-2026-0418",
  title: "ACME Freight Services",
  vendor: {
    name: "ACME Freight Services",
    location: "terminal 3, Bayonne NJ",
  },
  payer: {
    name: "Kaniefsky Transport LLC",
    location: "4th Ave, Brooklyn NY",
  },
  receivedDate: "Aug 18 2026",
  // Third-party PII — the redaction targets. Present in the assembled PDF,
  // absent from the document that goes for signature.
  shipment: {
    driverName: "Marcus Webb",
    driverPhone: "(201) 555-0142",
    driverEmail: "m.webb@acmefreight-drivers.example",
    tractorVin: "1FUJGLDR8CLBP8834",
    apContactName: "Dana Ruiz",
    apContactEmail: "ap@kaniefsky-transport.example",
    apContactPhone: "(718) 555-0197",
  },
  lineItems: [
    { description: "Parcel 1", quantity: 2, unitPrice: 14.5, total: 29.0 },
    { description: "Parcel 2", quantity: 1, unitPrice: 39.99, total: 39.99 },
    { description: "Handling", quantity: 3, unitPrice: 4.0, total: 12.0 },
  ],
  subtotal: 80.99,
  taxRate: 7.25,
  taxAmount: 5.87,
  totalDue: 86.86,
};

/**
 * Format a number as a USD string ($X.XX).
 * @param {number} n
 * @returns {string}
 */
export function usd(n) {
  return `$${Number(n).toFixed(2)}`;
}
