/**
 * Regression test for gh issue #41 — module-load guards must not lose their
 * error message when stderr is a pipe.
 *
 * Node writes stderr synchronously to a TTY but asynchronously to a pipe.
 * process.exit() tears the process down before the async buffer flushes, so
 * a `console.error(...); process.exit(1)` guard at module load loses its
 * diagnostic entirely under `… 2>&1 | tee run.log`.
 *
 * The fix is `fs.writeSync(2, msg + "\n")` — synchronous regardless of what
 * stderr is attached to.
 *
 * This test spawns a child that imports esign-adapter.mjs with a non-HTTPS
 * host, pipes stderr, and asserts the guard message is actually captured.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// A throwaway script that imports esign-adapter.mjs. The guard runs at module
// load time, so importing it with FOXIT_ESIGN_HOST=http://example.com triggers
// the fail-fast path we're testing.
function makeTriggerScript() {
  const script = `
import("${repoRoot}/mcp/foxit/esign-adapter.mjs").catch(() => {
  // Guard calls process.exit(1); we never reach here.
});
`;
  const scriptPath = join(tmpdir(), `no-undo-issue41-trigger-${process.pid}.mjs`);
  writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

describe("module-load guard under piped stderr (issue #41)", () => {
  let triggerPath;

  test("guard message is captured when stderr is a pipe", async () => {
    triggerPath = makeTriggerScript();

    const env = {
      ...process.env,
      FOXIT_ESIGN_HOST: "http://example.com",
    };

    const child = spawn(process.execPath, [triggerPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    const code = await new Promise((resolve) => child.on("close", resolve));

    // The guard must fail (exit 1), not silently succeed.
    assert.equal(code, 1, `expected exit 1, got code=${code}`);

    // The message MUST appear in the captured (piped) stderr.
    // Before the fix: stderr === "" (empty) because console.error lost its buffer.
    // After the fix: stderr contains the guard message via writeSync.
    assert.match(
      stderr,
      /FOXIT_ESIGN_HOST must use HTTPS/,
      `guard message was lost under piped stderr. stderr=${JSON.stringify(stderr)}, stdout=${JSON.stringify(stdout)}`
    );

    // Sanity: the process did not print the message to stdout either.
    assert.doesNotMatch(stdout, /FOXIT_ESIGN_HOST must use HTTPS/, "guard message leaked to stdout");
  });

  test("guard message is captured for invalid-URL input", async () => {
    triggerPath = makeTriggerScript();

    const env = {
      ...process.env,
      FOXIT_ESIGN_HOST: "not-a-url",
    };

    const child = spawn(process.execPath, [triggerPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { stderr += d; });

    const code = await new Promise((resolve) => child.on("close", resolve));

    assert.equal(code, 1);
    assert.match(
      stderr,
      /FOXIT_ESIGN_HOST is not a valid URL/,
      `invalid-URL message lost under piped stderr. stderr=${JSON.stringify(stderr)}`
    );
  });

  test("guard is silent when host is HTTPS (happy path)", async () => {
    triggerPath = makeTriggerScript();

    const env = {
      ...process.env,
      FOXIT_ESIGN_HOST: "https://na1.fusion.foxit.com",
      // No credentials: must not reach gateway. Guard passes; import proceeds
      // and tries to create durable stores at module load. We just need no
      // HTTPS-guard message — the rest of the module loads fine.
      FOXIT_CLIENT_ID: "test",
      FOXIT_CLIENT_SECRET: "test",
      NO_FOXIT_MCP: "1",
    };

    const child = spawn(process.execPath, [triggerPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { stderr += d; });

    const code = await new Promise((resolve) => child.on("close", resolve));

    assert.equal(code, 0, `expected exit 0, got code=${code}, stderr=${JSON.stringify(stderr)}`);
    assert.doesNotMatch(stderr, /must use HTTPS/, "HTTPS guard message shown for HTTPS host");
  });

  // Cleanup
  test("cleanup trigger script", () => {
    if (triggerPath) {
      try { unlinkSync(triggerPath); } catch { /* best effort */ }
    }
  });
});
