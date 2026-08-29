/**
 * Regression tests for gh issue #27 — parser must not fabricate recipient
 * emails on a live send. Covers:
 *   - prompt-parser: synthesized emails carry `resolved: false`
 *   - prompt-parser: explicit emails carry `resolved: true`
 *   - prompt-parser: parseRecipientFlag / mergeRecipients
 *   - agent-loop: unresolved recipients abort the send (status `not_executed`,
 *     code `UNRESOLVED_RECIPIENTS`) instead of mailing `@example.com`
 *   - agent-loop: --recipient override makes the same prompt send successfully
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Fixtures (mock fetch) ------------------------------------------------

const fixtures = new Map();

function defaultFixtures() {
  fixtures.clear();
  fixtures.set("GET:/esign/api/v1/folders/myfolder?folderId=35426627", {
    ok: true,
    status: 200,
    json: { result: "success", folder: { folderId: 35426627, folderName: "test", folderStatus: "DRAFT" } },
  });
  fixtures.set("POST:/esign/api/v1/folders/createfolder", {
    ok: true,
    status: 200,
    json: { folder: { folderId: 35426627, folderName: "test", folderStatus: "DRAFT" } },
  });
  fixtures.set("POST:/esign/api/v1/folders/sendDraftFolder", {
    ok: true,
    status: 200,
    json: { result: "success" },
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
      return {
        ok: fixture.ok,
        status: fixture.status,
        text: async () => fixture.text ?? JSON.stringify(fixture.json),
        json: async () => fixture.json,
      };
    }
    return {
      ok: false,
      status: 404,
      text: async () => "Not Found",
      json: async () => ({ error: "no fixture for " + key }),
    };
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NO_FOXIT_MCP;
});

function tmpJournal() {
  const dir = join(tmpdir(), "no-undo-issue27-test-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "test-journal.jsonl");
  return {
    path,
    cleanup: () => {
      for (const f of [
        path,
        `${path}.tmp`,
        join(dir, ".token-map.json"),
        join(dir, ".webhook-dedup.json"),
        join(dir, "esign-audit.jsonl"),
      ]) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
    },
  };
}

// --- prompt-parser unit tests ---------------------------------------------

describe("prompt-parser: recipient resolution (issue #27)", () => {
  test("flagship prompt produces unresolved recipients (Alice/Bob name match)", async () => {
    const { parsePrompt } = await import("../mcp/foxit/prompt-parser.mjs");
    const parsed = parsePrompt(
      "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.",
    );
    assert.ok(parsed.recipients.length >= 2, "at least 2 recipients");
    for (const r of parsed.recipients) {
      assert.equal(r.resolved, false, `synthesized recipient ${r.email} must be unresolved`);
      assert.match(r.email, /@example.com$/, "synthesized addresses use example.com");
    }
  });

  test("bare-name Carol match produces unresolved carol@example.com", async () => {
    const { parsePrompt } = await import("../mcp/foxit/prompt-parser.mjs");
    const parsed = parsePrompt("Send it to Carol for signature");
    assert.equal(parsed.recipients.length, 1);
    assert.equal(parsed.recipients[0].firstName, "Carol");
    assert.equal(parsed.recipients[0].resolved, false);
    assert.equal(parsed.recipients[0].email, "carol@example.com");
  });

  test("prompt with explicit email produces resolved recipient", async () => {
    const { parsePrompt } = await import("../mcp/foxit/prompt-parser.mjs");
    const parsed = parsePrompt("Send the contract to juan@real-domain.com for signature");
    assert.ok(parsed.recipients.length >= 1);
    const r = parsed.recipients[0];
    assert.equal(r.resolved, true, "explicit email must be resolved");
    assert.equal(r.email, "juan@real-domain.com");
  });

  test("prompt with multiple explicit emails — all resolved", async () => {
    const { parsePrompt } = await import("../mcp/foxit/prompt-parser.mjs");
    const parsed = parsePrompt("Send to alice@real.com and bob@real.com for signature");
    assert.equal(parsed.recipients.length, 2);
    assert.ok(parsed.recipients.every((r) => r.resolved === true));
  });

  test("no name, no email — fallback Alice/Bob are unresolved", async () => {
    const { parsePrompt } = await import("../mcp/foxit/prompt-parser.mjs");
    const parsed = parsePrompt("Please handle this document");
    assert.equal(parsed.recipients.length, 2);
    assert.ok(parsed.recipients.every((r) => r.resolved === false));
  });
});

describe("prompt-parser: parseRecipientFlag & mergeRecipients (issue #27)", () => {
  test("parseRecipientFlag parses 'Name <addr>'", async () => {
    const { parseRecipientFlag } = await import("../mcp/foxit/prompt-parser.mjs");
    const r = parseRecipientFlag("Juan Ka <juan@example.com>");
    assert.equal(r.firstName, "Juan");
    assert.equal(r.lastName, "Ka");
    assert.equal(r.email, "juan@example.com");
    assert.equal(r.resolved, true);
  });

  test("parseRecipientFlag parses bare email", async () => {
    const { parseRecipientFlag } = await import("../mcp/foxit/prompt-parser.mjs");
    const r = parseRecipientFlag("juan@real-domain.com");
    assert.equal(r.firstName, "Juan");
    assert.equal(r.email, "juan@real-domain.com");
    assert.equal(r.resolved, true);
  });

  test("parseRecipientFlag rejects empty string", async () => {
    const { parseRecipientFlag } = await import("../mcp/foxit/prompt-parser.mjs");
    assert.throws(() => parseRecipientFlag(""));
  });

  test("mergeRecipients: overrides replace parsed list", async () => {
    const { mergeRecipients } = await import("../mcp/foxit/prompt-parser.mjs");
    const parsed = [
      { firstName: "Alice", lastName: "Signer", email: "alice@example.com", resolved: false },
    ];
    const overrides = [
      { firstName: "Juan", lastName: "Ka", email: "juan@real.com", resolved: true },
    ];
    const merged = mergeRecipients(parsed, overrides);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].email, "juan@real.com");
    assert.equal(merged[0].resolved, true);
  });

  test("mergeRecipients: no overrides returns parsed unchanged", async () => {
    const { mergeRecipients } = await import("../mcp/foxit/prompt-parser.mjs");
    const parsed = [
      { firstName: "Alice", lastName: "Signer", email: "alice@example.com", resolved: false },
    ];
    const merged = mergeRecipients(parsed, []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].resolved, false);
  });
});

// --- Agent-loop integration: unresolved guard ------------------------------

describe("agent-loop: unresolved recipients guard (issue #27)", () => {
  test("flagship prompt without --recipient refuses to send", async () => {
    const { runFromPrompt } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    try {
      const result = await runFromPrompt(
        "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.",
        { journalPath: j.path, autoApprove: true },
      );
      assert.equal(result.status, "not_executed");
      assert.equal(result.code, "UNRESOLVED_RECIPIENTS");
      assert.match(result.error, /alice@example\.com|bob@example\.com/);
    } finally {
      j.cleanup();
    }
  });

  test("flagship prompt WITH --recipient override sends successfully", async () => {
    const { runFromPrompt } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    try {
      const result = await runFromPrompt(
        "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature.",
        {
          journalPath: j.path,
          autoApprove: true,
          recipients: [
            { firstName: "Juan", lastName: "Ka", email: "juan@real-domain.com" },
          ],
        },
      );
      assert.equal(result.status, "executed");
      assert.ok(result.folderId, "folderId present in result");
    } finally {
      j.cleanup();
    }
  });

  test("prompt with explicit email sends without --recipient", async () => {
    const { runFromPrompt } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    try {
      const result = await runFromPrompt(
        "Send the contract to alice@real-domain.com for signature",
        { journalPath: j.path, autoApprove: true },
      );
      assert.equal(result.status, "executed");
    } finally {
      j.cleanup();
    }
  });

  test("approval card flags unresolved recipients", async () => {
    const { renderEsignPlan } = await import("../agent/esign-agent-loop.mjs");
    const card = renderEsignPlan({
      payload: {
        folderName: "Freight Invoice",
        recipients: [
          { firstName: "Alice", lastName: "Signer", email: "alice@example.com", resolved: false },
        ],
      },
    });
    const recipientDetail = card.details.find((d) => d.label === "Recipients");
    assert.ok(recipientDetail, "Recipients detail row exists");
    assert.match(recipientDetail.value, /UNRESOLVED/);
  });

  test("programmatic override with malformed email throws (schema validation)", async () => {
    const { runFromPrompt } = await import("../agent/esign-agent-loop.mjs");
    const j = tmpJournal();
    try {
      await assert.rejects(
        () => runFromPrompt(
          "Send the contract to Alice for signature",
          {
            journalPath: j.path,
            autoApprove: true,
            recipients: [{ firstName: "Bad", lastName: "Recipient", email: "not-an-email" }],
          },
        ),
        /Invalid email|validation/i,
      );
    } finally {
      j.cleanup();
    }
  });
});

// --- CLI: --recipient without --prompt uses overrides (P1 fix) --------------

describe("CLI: --recipient without --prompt (issue #27 P1 fix)", () => {
  test("--recipient override is used even without --prompt", async () => {
    // Import main() indirectly by running the CLI via child_process
    const { execFileSync } = await import("node:child_process");
    const agentPath = join(__dirname, "..", "agent", "esign-agent-loop.mjs");
    let stderr = "";
    let exitCode = 0;
    try {
      execFileSync(
        "node",
        [
          agentPath,
          "my-folder",
          "--recipient", "Juan Ka <juan@real-domain.com>",
          "--auto-approve",
        ],
        {
          env: {
            ...process.env,
            FOXIT_CLIENT_ID: "test-client-id",
            FOXIT_CLIENT_SECRET: "test-client-secret",
            NO_FOXIT_MCP: "1",
          },
          encoding: "utf8",
          stdio: ["inherit", "inherit", "pipe"],
        },
      );
    } catch (e) {
      exitCode = e.status ?? 1;
      stderr = e.stderr ?? "";
    }
    // Should NOT fail with UNRESOLVED_RECIPIENTS — the override should be used.
    assert.doesNotMatch(stderr, /UNRESOLVED_RECIPIENTS/);
    // Should NOT have treated "Juan Ka <juan@real-domain.com>" as the folder name.
    assert.doesNotMatch(stderr, /folderName="Juan Ka/);
  });
});

// --- CLI: --poll-timeout value not treated as folder name (Greptile P1) -----

describe("CLI: --poll-timeout value not treated as folder name (Greptile P1 fix)", () => {
  test("--poll-timeout value before folder name is not used as folder name", async () => {
    const { execFileSync } = await import("node:child_process");
    const agentPath = join(__dirname, "..", "agent", "esign-agent-loop.mjs");
    let stderr = "";
    try {
      execFileSync(
        "node",
        [
          agentPath,
          "--poll-timeout", "5000",
          "my-folder",
          "--auto-approve",
        ],
        {
          env: {
            ...process.env,
            FOXIT_CLIENT_ID: "test-client-id",
            FOXIT_CLIENT_SECRET: "test-client-secret",
            NO_FOXIT_MCP: "1",
          },
          encoding: "utf8",
          stdio: ["inherit", "inherit", "pipe"],
        },
      );
    } catch (e) {
      stderr = e.stderr ?? "";
    }
    // Should NOT have treated "5000" as the folder name.
    assert.doesNotMatch(stderr, /folderName="5000"/);
  });

  test("--poll-timeout value alone is not treated as folder name", async () => {
    const { execFileSync } = await import("node:child_process");
    const agentPath = join(__dirname, "..", "agent", "esign-agent-loop.mjs");
    let stderr = "";
    try {
      execFileSync(
        "node",
        [
          agentPath,
          "--poll-timeout", "5000",
          "--auto-approve",
        ],
        {
          env: {
            ...process.env,
            FOXIT_CLIENT_ID: "test-client-id",
            FOXIT_CLIENT_SECRET: "test-client-secret",
            NO_FOXIT_MCP: "1",
          },
          encoding: "utf8",
          stdio: ["inherit", "inherit", "pipe"],
        },
      );
    } catch (e) {
      stderr = e.stderr ?? "";
    }
    // Should NOT have treated "5000" as the folder name.
    assert.doesNotMatch(stderr, /folderName="5000"/);
  });
});
