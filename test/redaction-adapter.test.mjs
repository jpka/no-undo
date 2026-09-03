/**
 * Tests for the Nutrient redaction adapter.
 *
 * Mocks fetch — does NOT call the live /build endpoint, because the apply path
 * is destructive by construction and a test suite must never be one network
 * misconfiguration away from shredding a real document.
 *
 * The properties worth protecting here:
 *   - staging never sends applyRedactions
 *   - applying always requires an approved plan
 *   - the digest binds an approval to one document plus one instruction set
 *   - the approval page never prints the PII being redacted
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  stageRedactions,
  applyRedactions,
  operationDigest,
  describeTarget,
  createRedactionStore,
  loadRedactionStore,
  createRedactionPlan,
  beginRedactionApply,
  confirmRedactionExecuted,
  confirmRedactionFailed,
  listExecutingRedactions,
  renderRedactionPlan,
} from "../mcp/nutrient/redaction-adapter.mjs";

/** Every /build request the mock saw, newest last. */
let calls = [];
let originalFetch;

beforeEach(() => {
  process.env.NUTRIENT_API_KEY = "test-processor-key";
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const instructions = init.body?.get?.("instructions");
    calls.push({ url: String(url), instructions: JSON.parse(instructions ?? "{}") });
    return {
      ok: true,
      status: 200,
      text: async () => "",
      arrayBuffer: async () => new TextEncoder().encode("%PDF-1.4 redacted").buffer,
    };
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A throwaway journal directory per test. */
function tmpJournal() {
  const dir = mkdtempSync(join(tmpdir(), "no-undo-redaction-"));
  return {
    path: join(dir, "journal.jsonl"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

const DOC = new TextEncoder().encode("%PDF-1.4 Kaniefsky 555-01-0042");
/** @type {any[]} */
const TARGETS = [{ strategy: "preset", preset: "social-security-number" }];

/** The action types in the most recent /build call. */
function lastActionTypes() {
  return calls.at(-1).instructions.actions.map((a) => a.type);
}

// --- Stage never applies ----------------------------------------------------

describe("stage vs apply", () => {
  test("staging sends createRedactions and never applyRedactions", () => {
    // If this ever regresses, the unattended step becomes destructive and the
    // entire gate is bypassed without anyone noticing.
    return stageRedactions(DOC, TARGETS).then((r) => {
      assert.equal(r.ok, true);
      assert.deepEqual(lastActionTypes(), ["createRedactions"]);
      assert.ok(!lastActionTypes().includes("applyRedactions"));
    });
  });

  test("applying sends createRedactions followed by applyRedactions", async () => {
    const r = await applyRedactions(DOC, TARGETS);
    assert.equal(r.ok, true);
    assert.deepEqual(lastActionTypes(), ["createRedactions", "applyRedactions"]);
  });

  test("staging reports what it staged and returns a digest", async () => {
    const r = await stageRedactions(DOC, TARGETS);
    assert.equal(r.staged.count, 1);
    assert.match(r.digest, /^[0-9a-f]{64}$/);
  });

  test("a rejected /build is reported, not thrown", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 422,
      text: async () => '{"error":"bad instructions"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const r = await stageRedactions(DOC, TARGETS);
    assert.equal(r.ok, false);
    assert.equal(r.status, 422);
    assert.equal(r.transportError, false);
  });

  test("a transport failure is distinguishable from a rejection", async () => {
    // The difference decides whether a retry is safe, so it must survive to the
    // caller rather than collapsing into a generic error.
    globalThis.fetch = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await applyRedactions(DOC, TARGETS);
    assert.equal(r.ok, false);
    assert.equal(r.transportError, true);
  });

  test("an empty target list is refused before any request is made", async () => {
    await assert.rejects(() => stageRedactions(DOC, []), /at least one redaction target/);
    assert.equal(calls.length, 0);
  });
});

// --- The digest binds the operation -----------------------------------------

describe("operationDigest", () => {
  test("is stable for the same document and targets", () => {
    assert.equal(operationDigest(DOC, TARGETS), operationDigest(DOC, TARGETS));
  });

  test("changes when the document changes", () => {
    const other = new TextEncoder().encode("%PDF-1.4 different document");
    assert.notEqual(operationDigest(DOC, TARGETS), operationDigest(other, TARGETS));
  });

  test("changes when the redaction rules change", () => {
    // Otherwise an approval for redacting SSNs would authorize redacting
    // something else entirely on the same document.
    const other = [{ strategy: "preset", preset: "email-address" }];
    assert.notEqual(operationDigest(DOC, TARGETS), operationDigest(DOC, other));
  });

  test("is insensitive to key order in the target objects", () => {
    const a = [{ strategy: "text", text: "acme", caseSensitive: true }];
    const b = [{ caseSensitive: true, text: "acme", strategy: "text" }];
    assert.equal(operationDigest(DOC, a), operationDigest(DOC, b));
  });
});

// --- The gate ---------------------------------------------------------------

describe("approval gate on the apply step", () => {
  test("an unapproved plan cannot begin the apply", async () => {
    const j = tmpJournal();
    try {
      const store = createRedactionStore(j.path);
      const staged = await stageRedactions(DOC, TARGETS);
      const payload = {
        documentName: "invoice.pdf",
        digest: staged.digest,
        targets: TARGETS,
        stagedCount: staged.staged.count,
      };
      const { planToken } = createRedactionPlan(store, payload);
      const r = beginRedactionApply(store, planToken, payload);
      assert.equal(r.ok, false);
      assert.match(r.error, /approval/i);
    } finally {
      j.cleanup();
    }
  });

  test("full lifecycle: stage, plan, approve, begin, apply, confirm", async () => {
    const j = tmpJournal();
    try {
      const store = createRedactionStore(j.path);
      const staged = await stageRedactions(DOC, TARGETS);
      const payload = {
        documentName: "invoice.pdf",
        digest: staged.digest,
        targets: TARGETS,
        stagedCount: staged.staged.count,
      };
      const { planToken } = createRedactionPlan(store, payload);
      assert.ok(store.approve(planToken).ok);

      const begun = beginRedactionApply(store, planToken, payload);
      assert.ok(begun.ok, `begin failed: ${begun.error}`);

      const applied = await applyRedactions(staged.bytes, TARGETS);
      assert.equal(applied.ok, true);

      const confirmed = await confirmRedactionExecuted(store, planToken);
      assert.equal(confirmed.ok, true);
    } finally {
      j.cleanup();
    }
  });

  test("a changed document fails closed on DATA_DIGEST_MISMATCH", async () => {
    // The TOCTOU guard. An approval covers one document; if the bytes change
    // after the human looked, the same token must not carry the apply through.
    // The payload is passed unchanged so the fingerprint check passes and the
    // digest check is what actually rejects — otherwise this test would pass for
    // the wrong reason.
    const j = tmpJournal();
    try {
      const store = createRedactionStore(j.path);
      const staged = await stageRedactions(DOC, TARGETS);
      const payload = {
        documentName: "invoice.pdf",
        digest: staged.digest,
        targets: TARGETS,
        stagedCount: 1,
      };
      const { planToken } = createRedactionPlan(store, payload);
      store.approve(planToken);

      const swappedDigest = operationDigest(
        new TextEncoder().encode("%PDF-1.4 a different document entirely"),
        TARGETS,
      );
      const r = beginRedactionApply(store, planToken, payload, swappedDigest);
      assert.equal(r.ok, false);
      assert.equal(r.code, "DATA_DIGEST_MISMATCH");
    } finally {
      j.cleanup();
    }
  });

  test("the plan is refused when no current digest can be supplied", () => {
    // The core treats an absent digest as a mismatch whenever the plan carries
    // one, so the adapter refuses early with a message that says why rather than
    // surfacing a confusing mismatch error.
    const j = tmpJournal();
    try {
      const store = createRedactionStore(j.path);
      const r = beginRedactionApply(store, "tok", { documentName: "x.pdf", targets: TARGETS });
      assert.equal(r.ok, false);
      assert.match(r.error, /digest is required/);
    } finally {
      j.cleanup();
    }
  });

  test("a plan created without a digest is refused", () => {
    const j = tmpJournal();
    try {
      const store = createRedactionStore(j.path);
      assert.throws(
        () => createRedactionPlan(store, { documentName: "x.pdf", targets: TARGETS }),
        /digest is required/,
      );
    } finally {
      j.cleanup();
    }
  });

  test("beginRedactionApply refuses without a payload", () => {
    const j = tmpJournal();
    try {
      const store = createRedactionStore(j.path);
      const r = beginRedactionApply(store, "some-token", undefined);
      assert.equal(r.ok, false);
      assert.match(r.error, /payload is required/);
    } finally {
      j.cleanup();
    }
  });

  test("a plan interrupted mid-apply stays visible as executing", async () => {
    // Redaction cannot be reconciled server-side, so this list is the only way a
    // stuck plan is ever noticed. If it came back empty the plan would be lost.
    const j = tmpJournal();
    try {
      const store = createRedactionStore(j.path);
      const staged = await stageRedactions(DOC, TARGETS);
      const payload = {
        documentName: "invoice.pdf",
        digest: staged.digest,
        targets: TARGETS,
        stagedCount: 1,
      };
      const { planToken } = createRedactionPlan(store, payload);
      store.approve(planToken);
      beginRedactionApply(store, planToken, payload);
      // Process "dies" here — no confirm of either kind.
      assert.equal(listExecutingRedactions(store).length, 1);
    } finally {
      j.cleanup();
    }
  });
});

// --- The approval page must not leak what it is hiding -----------------------

describe("renderRedactionPlan", () => {
  test("never prints the literal text being redacted", () => {
    // The reviewer must not have to read the secret in order to approve hiding
    // it. A literal target IS the sensitive value, so it is described by shape.
    const rendered = renderRedactionPlan({
      payload: {
        documentName: "invoice.pdf",
        digest: "a".repeat(64),
        targets: [{ strategy: "text", text: "555-01-0042" }],
        stagedCount: 1,
      },
      reason: "Redact SSN before signature",
    });
    const serialized = JSON.stringify(rendered);
    assert.ok(!serialized.includes("555-01-0042"), "the redacted value must not appear in the UI");
    assert.match(serialized, /withheld from this view/);
  });

  test("names a preset category, which is what the reviewer needs", () => {
    const rendered = renderRedactionPlan({
      payload: {
        documentName: "invoice.pdf",
        digest: "b".repeat(64),
        targets: [{ strategy: "preset", preset: "social-security-number" }],
        stagedCount: 1,
      },
    });
    assert.match(JSON.stringify(rendered), /social-security-number/);
  });

  test("states the irreversibility explicitly", () => {
    const rendered = renderRedactionPlan({
      payload: { documentName: "x.pdf", digest: "c".repeat(64), targets: TARGETS },
    });
    const warning = rendered.details.find((d) => /irreversible/i.test(d.label));
    assert.ok(warning, "an irreversibility warning must be present");
    assert.match(warning.value, /cannot be (recovered|undone)/i);
  });

  test("truncates the digest rather than dumping it", () => {
    const rendered = renderRedactionPlan({
      payload: { documentName: "x.pdf", digest: "d".repeat(64), targets: TARGETS },
    });
    const row = rendered.details.find((d) => d.label === "Document digest");
    assert.ok(row.value.length < 30);
  });

  test("survives a plan with no payload without throwing", () => {
    const rendered = renderRedactionPlan({ extra: { documentName: "recovered.pdf" } });
    assert.match(rendered.title, /recovered\.pdf/);
  });
});

// --- Target descriptions ----------------------------------------------------

describe("describeTarget", () => {
  test("describes a literal by length and sensitivity, not content", () => {
    const d = describeTarget({ strategy: "text", text: "Kaniefsky", caseSensitive: true });
    assert.ok(!d.includes("Kaniefsky"));
    assert.match(d, /9 chars/);
    assert.match(d, /case-sensitive/);
  });

  test("names presets and regexes directly", () => {
    assert.match(describeTarget({ strategy: "preset", preset: "email-address" }), /email-address/);
    assert.match(describeTarget({ strategy: "regex", regex: "\\d{3}-\\d{2}" }), /regex/);
  });

  test("never prints a regex pattern, which can embed the value being hidden", () => {
    // /Kaniefsky|555-01-0042/ is a matcher made of exactly the secrets it hides.
    const d = describeTarget({ strategy: "regex", regex: "Kaniefsky|555-01-0042" });
    assert.ok(!d.includes("Kaniefsky"), "literal in the pattern must not reach the UI");
    assert.ok(!d.includes("555-01-0042"));
    assert.match(d, /withheld from this view/);
    assert.match(d, /contains literal runs/);
  });

  test("distinguishes a pure character-class regex from one carrying literals", () => {
    const classes = describeTarget({ strategy: "regex", regex: "\\d{3}-\\d{2}-\\d{4}" });
    assert.match(classes, /character classes only/);
  });

  test("flags a preset confirmed to accept but not match (Finding 4)", () => {
    // vin returns 200 from /build and redacts nothing — see NONFUNCTIONAL_PRESETS
    // and docs/nutrient-redaction-sep1.md Finding 4. A human approving a plan off
    // this description alone must not be able to mistake it for a working preset.
    const d = describeTarget({ strategy: "preset", preset: "vin" });
    assert.match(d, /vin/);
    assert.match(d, /non-functional/);
    assert.match(d, /redacts nothing/);
  });

  test("does not flag a preset confirmed to actually match", () => {
    const d = describeTarget({ strategy: "preset", preset: "email-address" });
    assert.ok(!d.includes("non-functional"), `unexpected warning on a working preset: ${d}`);
  });
});

// --- Security-critical option handling --------------------------------------

describe("createRedactionPlan cannot be talked out of the gate", () => {
  test("alwaysRequireApproval cannot be disabled by the caller", async () => {
    // The spread order is the whole defense here: with `...options` last, a
    // caller could hand itself an ungated irreversible action.
    const j = tmpJournal();
    try {
      const store = createRedactionStore(j.path);
      const staged = await stageRedactions(DOC, TARGETS);
      const payload = {
        documentName: "invoice.pdf",
        digest: staged.digest,
        targets: TARGETS,
        stagedCount: 1,
      };
      const { planToken } = createRedactionPlan(store, payload, {
        alwaysRequireApproval: false,
      });
      const r = beginRedactionApply(store, planToken, payload, staged.digest);
      assert.equal(r.ok, false, "the gate must hold even when the caller asks to skip it");
      assert.match(r.error, /approval/i);
    } finally {
      j.cleanup();
    }
  });

  test("dataDigest cannot be replaced by the caller", async () => {
    // Otherwise an approval could be bound to a digest the caller chose rather
    // than to the document that will actually be redacted.
    const j = tmpJournal();
    try {
      const store = createRedactionStore(j.path);
      const staged = await stageRedactions(DOC, TARGETS);
      const payload = {
        documentName: "invoice.pdf",
        digest: staged.digest,
        targets: TARGETS,
        stagedCount: 1,
      };
      const { planToken } = createRedactionPlan(store, payload, {
        dataDigest: "0".repeat(64),
      });
      store.approve(planToken);
      // The plan is bound to the real staged digest, so that is what passes...
      const good = beginRedactionApply(store, planToken, payload, staged.digest);
      assert.equal(good.ok, true, "the real staged digest must be the binding");
    } finally {
      j.cleanup();
    }
  });
});

// --- The audit sink must not corrupt the MCP stream -------------------------

describe("audit sink", () => {
  test("both store constructors write audit events to stderr, not stdout", async () => {
    // stdout carries the MCP JSON-RPC stream. An audit line there is a parse
    // error at the client and the session is corrupted. Verified separately: a
    // client reading stdout line-by-line fails on the audit line.
    const j = tmpJournal();
    const outLines = [];
    const errLines = [];
    const origOut = console.log;
    const origErr = console.error;
    console.log = (...a) => outLines.push(a.join(" "));
    console.error = (...a) => errLines.push(a.join(" "));
    try {
      const store = createRedactionStore(j.path);
      const staged = await stageRedactions(DOC, TARGETS);
      createRedactionPlan(store, {
        documentName: "d.pdf",
        digest: staged.digest,
        targets: TARGETS,
        stagedCount: 1,
      });
    } finally {
      console.log = origOut;
      console.error = origErr;
      j.cleanup();
    }
    assert.deepEqual(
      outLines.filter((l) => l.includes("redaction-audit")),
      [],
      "no audit line may reach stdout",
    );
    assert.ok(
      errLines.some((l) => l.includes("redaction-audit")),
      "audit events must actually be emitted, on stderr",
    );
  });

  test("loadRedactionStore carries an audit sink", async () => {
    // This is the constructor the production server uses. It previously passed no
    // `audit` option at all, so the running server recorded nothing while the
    // unused create path had a sink — an approval gate that does not record its
    // decisions defeats the point.
    const j = tmpJournal();
    const errLines = [];
    const origErr = console.error;
    console.error = (...a) => errLines.push(a.join(" "));
    try {
      const store = await loadRedactionStore(j.path);
      const staged = await stageRedactions(DOC, TARGETS);
      createRedactionPlan(store, {
        documentName: "d.pdf",
        digest: staged.digest,
        targets: TARGETS,
        stagedCount: 1,
      });
    } finally {
      console.error = origErr;
      j.cleanup();
    }
    assert.ok(
      errLines.some((l) => l.includes("redaction-audit")),
      "loadRedactionStore must emit audit events",
    );
  });

  test("a caller can still override the audit sink", async () => {
    const j = tmpJournal();
    const seen = [];
    try {
      const store = await loadRedactionStore(j.path, {
        audit: { record: (e) => void seen.push(e.status) },
      });
      const staged = await stageRedactions(DOC, TARGETS);
      createRedactionPlan(store, {
        documentName: "d.pdf",
        digest: staged.digest,
        targets: TARGETS,
        stagedCount: 1,
      });
    } finally {
      j.cleanup();
    }
    assert.ok(seen.length > 0, "the supplied sink should receive events");
  });
});

// --- Releasing a plan leaves it approved ------------------------------------

describe("release semantics", () => {
  test("a released plan can begin again without new approval", () => {
    // Documenting the real behaviour rather than asserting a guarantee the core
    // does not provide: confirmFailed returns a plan to retryable but does NOT
    // revoke the approval, so one human decision authorizes every subsequent
    // retry. That is why the MCP tool now demands a 4xx/5xx rejection status —
    // the agent must not be able to release a plan whose outcome is unknown.
    const j = tmpJournal();
    try {
      const store = createRedactionStore(j.path);
      const digest = operationDigest(DOC, TARGETS);
      const payload = {
        documentName: "d.pdf",
        digest,
        targets: TARGETS,
        stagedCount: 1,
      };
      const { planToken } = createRedactionPlan(store, payload);
      store.approve(planToken);
      assert.ok(beginRedactionApply(store, planToken, payload, digest).ok);
      return confirmRedactionFailed(store, planToken, "HTTP 422").then((released) => {
        assert.ok(released.ok);
        const again = beginRedactionApply(store, planToken, payload, digest);
        assert.equal(
          again.ok,
          true,
          "the core keeps the approval across a release; the tool layer is what constrains this",
        );
        j.cleanup();
      });
    } catch (err) {
      j.cleanup();
      throw err;
    }
  });
});

describe("confirm helpers branch on ok alone", () => {
  /** A store stub whose confirms fail without attaching an error object. */
  function silentlyFailingStore() {
    return {
      confirmExecuted: async () => ({ ok: false }),
      confirmFailed: async () => ({ ok: false }),
    };
  }

  test("confirmRedactionExecuted reports failure when no error object is attached", async () => {
    // The bug this guards: `!result.ok && result.error` fell through to ok:true,
    // writing a false "executed" claim into the log this module keeps honest.
    const r = await confirmRedactionExecuted(silentlyFailingStore(), "tok");
    assert.equal(r.ok, false);
    assert.match(r.error, /without reporting a reason/);
  });

  test("confirmRedactionFailed reports failure when no error object is attached", async () => {
    const r = await confirmRedactionFailed(silentlyFailingStore(), "tok", "why");
    assert.equal(r.ok, false);
    assert.match(r.error, /without reporting a reason/);
  });
});
