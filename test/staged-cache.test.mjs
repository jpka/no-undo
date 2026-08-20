/**
 * Tests for the Nutrient MCP server's staged-document cache.
 *
 * The cache holds whole documents that still contain the unredacted content, so
 * its bounds are a confidentiality property, not a memory optimization: an entry
 * that outlives the plan it belongs to is PII pinned in memory for no reason.
 *
 * Importing the server module must not start it — the entry point is guarded by
 * an import.meta.url check, and this suite is what would hang if that guard were
 * ever removed.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, sep, basename } from "node:path";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  __stagedCacheForTest,
  safePath,
  CANONICAL_ROOT,
  assertDistinct,
} from "../mcp/nutrient/nutrient-mcp-server.mjs";

const { map, max, ttlMs, prune } = __stagedCacheForTest;

/** Insert a synthetic staged entry. */
function add(token, stagedAt) {
  map.set(token, {
    bytes: new Uint8Array([1, 2, 3]),
    targets: [{ strategy: "preset", preset: "email-address" }],
    fileName: `${token}.pdf`,
    stagedAt,
  });
}

beforeEach(() => {
  map.clear();
});

describe("staged document cache bounds", () => {
  test("importing the server does not start it", () => {
    // If the entry-point guard regresses, this suite hangs on the stdio
    // transport instead of failing, so reaching this assertion is the signal.
    assert.ok(__stagedCacheForTest, "module imported without booting main()");
  });

  test("entries within the TTL survive a prune", () => {
    const now = Date.now();
    add("fresh", now);
    prune(now);
    assert.equal(map.size, 1);
  });

  test("entries past the TTL are evicted", () => {
    // Once a plan can no longer execute, holding its document buys nothing and
    // costs exposure.
    const now = Date.now();
    add("stale", now - ttlMs - 1);
    prune(now);
    assert.equal(map.size, 0);
  });

  test("an entry exactly at the TTL boundary is kept", () => {
    const now = Date.now();
    add("edge", now - ttlMs);
    prune(now);
    assert.equal(map.size, 1, "eviction is strictly past the TTL, not at it");
  });

  test("the cap evicts oldest-first", () => {
    const now = Date.now();
    for (let i = 0; i < max + 5; i++) add(`t${i}`, now);
    prune(now);
    assert.equal(map.size, max);
    // Map iterates in insertion order, so the earliest inserted go first.
    assert.ok(!map.has("t0"), "oldest entry evicted");
    assert.ok(map.has(`t${max + 4}`), "newest entry retained");
  });

  test("a never-approved plan cannot pin a document indefinitely", () => {
    // The leak this bound exists to prevent: stage, never approve, walk away.
    const staged = Date.now();
    add("abandoned", staged);
    prune(staged + ttlMs + 1);
    assert.equal(map.size, 0, "abandoned staged document must not outlive its plan");
  });
});

// --- Path confinement --------------------------------------------------------

describe("safePath", () => {
  test("accepts a path inside the document root", () => {
    const p = safePath("docs/invoice.pdf", "filePath");
    assert.ok(p.startsWith(CANONICAL_ROOT + sep));
  });

  test("resolves a relative path against the root rather than the cwd", () => {
    assert.equal(safePath("a/b.pdf", "filePath"), join(CANONICAL_ROOT, "a", "b.pdf"));
  });

  for (const traversal of [
    "../../../etc/passwd",
    "docs/../../../../etc/shadow",
    "/etc/passwd",
    "/root/.ssh/id_rsa",
  ]) {
    test(`rejects ${traversal}`, () => {
      // These are not hypothetical: the stage and extract tools upload the bytes
      // at whatever path they are given to a third-party API.
      assert.throws(() => safePath(traversal, "filePath"), /outside the document root/);
    });
  }

  test("rejects a sibling directory that merely shares a name prefix", () => {
    // The check appends the separator for exactly this case — a plain startsWith
    // would let /root-evil pass next to /root.
    const sibling = CANONICAL_ROOT + "-evil/doc.pdf";
    assert.throws(() => safePath(sibling, "filePath"), /outside the document root/);
  });

  test("rejects an empty or non-string path", () => {
    assert.throws(() => safePath("", "filePath"), /non-empty path/);
    assert.throws(() => safePath(undefined, "filePath"), /non-empty path/);
  });

  test("the root itself is allowed", () => {
    assert.equal(safePath(CANONICAL_ROOT, "filePath"), CANONICAL_ROOT);
  });

  test("rejects an in-root symlink pointing outside the root", () => {
    // resolve() only normalizes text, so a symlink inside the root produces a
    // resolved path that passes a prefix check and still reads the target
    // (CWE-59). Verified by hand before the fix: a root-relative link to
    // /tmp/outside.txt read the outside file. Canonicalization is what closes it.
    const dir = mkdtempSync(join(tmpdir(), "no-undo-symlink-"));
    const outside = join(dir, "outside.txt");
    const link = join(CANONICAL_ROOT, `sym-escape-${process.pid}.txt`);
    try {
      writeFileSync(outside, "SECRET OUTSIDE ROOT");
      symlinkSync(outside, link);
      assert.throws(() => safePath(basename(link), "filePath"), /outside the document root/);
    } finally {
      try {
        unlinkSync(link);
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a path whose parent directory is an escaping symlink", () => {
    // The leaf need not exist — that is normal for an output path — but a symlinked
    // ancestor is exactly the case the deepest-existing-ancestor walk exists for.
    const dir = mkdtempSync(join(tmpdir(), "no-undo-symdir-"));
    const link = join(CANONICAL_ROOT, `sym-dir-${process.pid}`);
    try {
      symlinkSync(dir, link);
      assert.throws(
        () => safePath(join(basename(link), "not-created-yet.pdf"), "outputPath"),
        /outside the document root/,
      );
    } finally {
      try {
        unlinkSync(link);
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-existent in-root output path is still accepted", () => {
    // Canonicalization must not reject paths that simply do not exist yet.
    const p = safePath("does/not/exist/out.pdf", "outputPath");
    assert.ok(p.startsWith(CANONICAL_ROOT + sep));
  });
});

// --- Clobber guard -----------------------------------------------------------

describe("assertDistinct", () => {
  test("refuses a write whose destination is its own source", () => {
    // On the apply path the source is the last intact copy of the unredacted
    // document, so overwriting it in place loses the original entirely.
    assert.throws(
      () => assertDistinct("/root/doc.pdf", "/root/doc.pdf"),
      /refusing to overwrite the source/,
    );
  });

  test("allows distinct paths", () => {
    assert.doesNotThrow(() => assertDistinct("/root/doc.pdf", "/root/doc.staged.pdf"));
  });
});
