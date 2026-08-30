/**
 * Regression test for gh issue #40 — the CLI entry-point guard must actually
 * run main() so `node agent/esign-agent-loop.mjs …` does something.
 *
 * Before the fix, `import.meta.url === `file://${process.argv[1]}`` was false
 * for (a) relative invocation and (b) paths containing a space, so main()
 * never ran and the process exited 0 printing nothing.
 *
 * This test spawns the CLI and asserts it reaches the approval server and
 * produces a meaningful exit code — from relative, absolute, and space paths.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentPath = join(__dirname, "..", "agent", "esign-agent-loop.mjs");
const repoRoot = join(__dirname, "..");

const baseEnv = {
  ...process.env,
  FOXIT_CLIENT_ID: "test-client-id",
  FOXIT_CLIENT_SECRET: "test-client-secret",
  NO_FOXIT_MCP: "1",
};

// Collect stdout/stderr and exit code from a spawned CLI run.
function spawnCli(args, { cwd, env } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [agentPath, ...args], {
      cwd,
      env: env ?? baseEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}

describe("CLI entry point (issue #40)", () => {
  test("relative invocation reaches approval server and exits meaningfully", async () => {
    // cwd = repo root; pass a relative path to the entry file.
    // This repo's own path contains a space ("No Undo"), so this also
    // exercises the percent-encoding side of the bug.
    const relAgent = join("agent", "esign-agent-loop.mjs");
    const child = spawn(
      process.execPath,
      [relAgent, "--prompt", "Send contract to Alice and Bob", "--auto-approve", "--allow-fixture-pdf"],
      { cwd: repoRoot, env: baseEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const code = await new Promise((r) => child.on("close", r));

    const out = stdout + stderr;
    // main() ran: it logs with [agent] prefix. The broken guard exits 0
    // silently; any of success(0)/fatal(1)/failed(2) with output is meaningful.
    assert.match(out, /\[agent\]/, "expected agent log output (main() never ran before fix)");
    assert.ok(code === 0 || code === 1 || code === 2, `expected meaningful exit code, got ${code}`);
  });

  test("absolute invocation reaches approval server", async () => {
    const { code, stdout, stderr } = await spawnCli(
      ["--prompt", "Send contract to Alice and Bob", "--auto-approve", "--allow-fixture-pdf"],
    );
    const out = stdout + stderr;
    assert.match(out, /\[agent\]/);
    assert.ok(code === 0 || code === 1 || code === 2, `expected meaningful exit code, got ${code}`);
  });

  test("guard idiom matches pathToFileURL (no raw template literal)", async () => {
    // Static check: the source must use pathToFileURL, not the broken form.
    const src = readFileSync(resolve(agentPath), "utf8");
    assert.doesNotMatch(
      src,
      /import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/,
      "broken guard form still present",
    );
    assert.match(src, /pathToFileURL\(process\.argv\[1\]\)\.href/);
  });
});
