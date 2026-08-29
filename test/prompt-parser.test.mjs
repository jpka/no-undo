/**
 * Tests for the plain-prompt parser.
 *
 * Fixture-seam tests — no live LLM, no network. The parser must be fully
 * deterministic in CI.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parsePrompt,
  parsePromptLlm,
  isValidPrompt,
  RecipientSchema,
  ParsedPromptSchema,
} from "../mcp/foxit/prompt-parser.mjs";

describe("prompt-parser", () => {
  test("parses freight invoice prompt with named recipients", () => {
    const result = parsePrompt(
      "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.",
    );
    assert.equal(result.folderName, "Freight Invoice");
    assert.equal(result.recipients.length, 2);
    assert.deepEqual(result.recipients[0], {
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
      resolved: false,
    });
    assert.deepEqual(result.recipients[1], {
      firstName: "Bob",
      lastName: "Jones",
      email: "bob@example.com",
      resolved: false,
    });
    assert.equal(result.docSource, null);
    assert.match(result.instructions, /redact PII/);
    assert.match(result.instructions, /send for signature/);
    assert.equal(
      result.promptExcerpt,
      "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.",
    );
  });

  test("parses prompt with explicit email addresses", () => {
    const result = parsePrompt("Send the contract to alice@example.com for signature");
    assert.equal(result.folderName, "Contract");
    assert.equal(result.recipients.length, 1);
    assert.equal(result.recipients[0].email, "alice@example.com");
    assert.equal(result.recipients[0].firstName, "Alice");
    assert.match(result.instructions, /send for signature/);
  });

  test("parses prompt with PDF source and multiple emails", () => {
    const result = parsePrompt(
      "Please send invoice.pdf to bob@example.com and carol@example.org",
    );
    assert.equal(result.folderName, "Invoice");
    assert.equal(result.recipients.length, 2);
    assert.equal(result.recipients[0].email, "bob@example.com");
    assert.equal(result.recipients[1].email, "carol@example.org");
    assert.equal(result.docSource, "invoice.pdf");
  });

  test("extracts folder name from quoted string", () => {
    const result = parsePrompt('Send "Q3 Sales Agreement" to dave@example.com');
    assert.equal(result.folderName, "Q3 Sales Agreement");
    assert.equal(result.recipients.length, 1);
  });

  test("derives first/last name from dotted email local part", () => {
    const result = parsePrompt("Send to john.smith@example.com");
    assert.equal(result.recipients[0].firstName, "John");
    assert.equal(result.recipients[0].lastName, "Smith");
  });

  test("truncates long prompts in excerpt", () => {
    const longPrompt =
      "This is a very long prompt that exceeds one hundred and twenty characters quite significantly " +
      "and should be truncated in the excerpt field to keep the approval card readable always";
    const result = parsePrompt(`${longPrompt} to alice@example.com`);
    assert.ok(result.promptExcerpt.length <= 121);
    assert.match(result.promptExcerpt, /…$/);
  });

  test("falls back to generic recipients when no names or emails found", () => {
    const result = parsePrompt("Send the document for signature");
    assert.ok(result.recipients.length >= 1);
    assert.equal(result.recipients[0].email, "alice@example.com");
  });

  test("detects document types (nda, purchase order)", () => {
    const nda = parsePrompt("Send the NDA to legal@example.com");
    assert.equal(nda.folderName, "NDA");
    const po = parsePrompt("Send purchase order to vendor@example.com");
    assert.equal(po.folderName, "Purchase Order");
  });

  test("throws on empty or non-string input", () => {
    assert.throws(() => parsePrompt(""));
    assert.throws(() => parsePrompt("   "));
    assert.throws(() => parsePrompt(123));
    assert.throws(() => parsePrompt(null));
  });

  test("isValidPrompt returns true/false without throwing", () => {
    assert.equal(isValidPrompt("Send to alice@example.com"), true);
    assert.equal(isValidPrompt(""), false);
    assert.equal(isValidPrompt(42), false);
  });

  test("parsePromptLlm returns same result as parsePrompt (offline fallback)", async () => {
    const prompt = "Send the contract to eve@example.com for signature";
    const regexResult = parsePrompt(prompt);
    const llmResult = await parsePromptLlm(prompt);
    assert.deepEqual(llmResult, regexResult);
  });

  test("RecipientSchema validates email format", () => {
    assert.throws(() =>
      RecipientSchema.parse({ firstName: "A", lastName: "B", email: "not-an-email" }),
    );
    assert.doesNotThrow(() =>
      RecipientSchema.parse({ firstName: "A", lastName: "B", email: "a@b.co" }),
    );
  });

  test("ParsedPromptSchema requires at least one recipient", () => {
    assert.throws(() =>
      ParsedPromptSchema.parse({
        folderName: "Test",
        recipients: [],
        promptExcerpt: "x",
      }),
    );
  });

  test("extractInstructions returns null when no keywords present", () => {
    const result = parsePrompt("Send to alice@example.com");
    assert.equal(result.instructions, null);
  });

  test("substring false positive — 'malice' must not extract named Alice", () => {
    const result = parsePrompt("Send the malice report for signature");
    const hasNamedAlice = result.recipients.some((r) => r.firstName === "Alice" && r.lastName === "Smith");
    assert.equal(hasNamedAlice, false);
  });

  test("duplicate emails produce a single recipient", () => {
    const result = parsePrompt("Send to alice@example.com and alice@example.com");
    assert.equal(result.recipients.length, 1);
  });

  test("capitalize only uppercases first char, leaves rest as-is", () => {
    const result = parsePrompt("Send to mcdonald@example.com");
    assert.equal(result.recipients[0].firstName, "Mcdonald");
  });

  test("throws on excessively long prompt", () => {
    const long = "x".repeat(10_001);
    assert.throws(() => parsePrompt(long), /exceeds max length/);
  });

  test("sign does not match 'design' or 'assign'", () => {
    const result = parsePrompt("Send the design file to alice@example.com for review");
    assert.match(result.instructions, /review required/);
    assert.doesNotMatch(result.instructions, /signature/);
  });

  test("folder name truncation walks back to last space", () => {
    const long =
      "This is a very long prompt that exceeds the forty character limit for folder names";
    const result = parsePrompt(`${long} to alice@example.com`);
    assert.match(result.folderName, /…$/);
    assert.ok(result.folderName.length <= 42);
    assert.doesNotMatch(result.folderName, /\s…$/);
  });
});
