#!/usr/bin/env node
/**
 * Serve the approval card with realistic data, for design work.
 *
 * A full `demo.mjs gate` run costs Nutrient credits and creates a real eSign
 * draft, which is a poor way to check whether a border radius looks right.
 * This builds a plan carrying the same shapes a real run produces — including
 * the two em-dash-joined Nutrient summaries — and serves it locally.
 *
 *   node scripts/preview-card.mjs           # styled (mcp/lib/approval-ui.mjs)
 *   node scripts/preview-card.mjs --plain   # the core's own styling, to compare
 *
 * Approving here does nothing but mark an in-memory plan. Nothing is sent.
 */

import { PlanStore, startApprovalServer } from "safe-write-mcp-core";
import { startStyledApprovalServer } from "../mcp/lib/approval-ui.mjs";
import { renderEsignPlan } from "../agent/esign-agent-loop.mjs";

const plain = process.argv.includes("--plain");

const store = new PlanStore({ planTtlMs: 30 * 60 * 1000 });
store.create(
  {
    folderName: "Freight Invoice",
    folderId: 35704276,
    recipients: [
      { firstName: "Alice", lastName: "Smith", email: "alice@example.com" },
      { firstName: "Bob", lastName: "Jones", email: "bob@example.com" },
    ],
  },
  {
    tool: "esign_send",
    reason: "The prompt asked for the invoice to be sent for signature.",
    alwaysRequireApproval: true,
    extra: {
      folderId: 35704276,
      documentSha256: "17ba1004d0943d846ea83969eb970873e83a01f37d22a2401b8c998557cec75f",
      documentVia: "enriched-source",
      promptExcerpt:
        "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.",
      promptDocSource: "generated messy invoice",
      promptInstructions: "redact PII; send for signature",
      nutrientSummary:
        "2/16 fields auto-approved — 14 need human review — 11 caught by OCR recognition floor: " +
        "vendor_name, payer_name, line_items[0].description, line_items[0].quantity, " +
        "line_items[0].unit_price, line_items[1].description, line_items[1].quantity, " +
        "line_items[1].unit_price, line_items[2].description, line_items[2].quantity, " +
        "line_items[2].unit_price — 2 ungrounded (not_found): due_date, po_number — " +
        "thresholds calibrated: false",
      redactionSummary:
        "3 target set(s) applied (preset: email-address; preset: north-american-phone-number; " +
        "regex (19 chars, character classes only) — pattern withheld from this view) — " +
        "5 value(s) verified absent from the outgoing document, 1 signature field(s) verified intact",
    },
  },
);

const start = plain ? startApprovalServer : startStyledApprovalServer;
const handle = await start(store, {
  title: "No Undo — approval queue",
  renderPlan: renderEsignPlan,
});

console.log(`\n  ${plain ? "core styling" : "project styling"}: http://${handle.host}:${handle.port}\n`);
console.log("  Nothing here sends anything. Ctrl-C to stop.\n");
