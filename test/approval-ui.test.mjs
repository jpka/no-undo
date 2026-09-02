/**
 * Tripwire for the styled approval page.
 *
 * mcp/lib/approval-ui.mjs delegates every request to safe-write-mcp-core's own
 * handler and rewrites only the CSS on the way out. That buys us the core's
 * provenance checks for free — but only for as long as the assumptions hold.
 * These tests exist to fail loudly if a future core version moves the `<style>`
 * anchor, changes how it writes responses, or if the delegation ever stops
 * preserving the Host/localPort agreement the approve endpoint depends on.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PlanStore } from "safe-write-mcp-core";
import { startStyledApprovalServer, restyleHtml } from "../mcp/lib/approval-ui.mjs";

describe("styled approval page", () => {
  /** @type {{port: number, host: string, close(): Promise<void>}} */
  let handle;
  let store;
  let planToken;
  let origin;

  before(async () => {
    store = new PlanStore({ planTtlMs: 60_000 });
    const created = store.create(
      { folderName: "Freight Invoice", recipients: [{ email: "alice@example.com" }] },
      { tool: "esign_send", reason: "test", alwaysRequireApproval: true },
    );
    planToken = created.planToken;
    handle = await startStyledApprovalServer(store, {
      title: "Sign",
      renderPlan: () => ({ title: "Sign: Freight Invoice", details: [{ label: "Recipients", value: "alice@example.com" }] }),
    });
    origin = `http://127.0.0.1:${handle.port}`;
  });

  after(async () => {
    await handle?.close();
  });

  test("serves the page with our stylesheet, not the core's", async () => {
    const res = await fetch(origin);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /--surface: #161b22/, "project palette missing");
    assert.doesNotMatch(html, /font-family: system-ui, sans-serif; margin: 2rem auto/,
      "core's default stylesheet still present");
  });

  test("Content-Length matches the rewritten body", async () => {
    const res = await fetch(origin);
    const html = await res.text();
    assert.equal(Number(res.headers.get("content-length")), Buffer.byteLength(html));
  });

  test("leaves the approve/reject client script intact", async () => {
    const html = await fetch(origin).then((r) => r.text());
    assert.match(html, /data-action/, "action buttons gone");
    assert.match(html, /\/api\/plans\//, "client fetch path gone");
  });

  test("does not touch JSON routes", async () => {
    const res = await fetch(`${origin}/api/plans`);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.ok(Array.isArray(body.plans ?? body), "plan list not returned as JSON");
  });

  // The reason we delegate instead of serving our own page: the core pins the
  // Host header to req.socket.localPort. Delegating on our own socket keeps
  // that true. If this ever passes with a foreign Host, the check is gone.
  //
  // Uses node:http, not fetch — `Host` is a forbidden header name in fetch, so
  // undici drops the override and sends the real one. The request then
  // succeeds and the test passes while proving nothing at all.
  test("still rejects a request whose Host is not this loopback port", async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1", port: handle.port, method: "POST",
          path: `/api/plans/${planToken}/approve`,
          headers: { "Content-Type": "application/json", Host: "evil.example", "Content-Length": 2 },
        },
        (res) => { res.resume(); resolve(res.statusCode); },
      );
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, 403);
  });

  test("approves through the delegated endpoint", async () => {
    const res = await fetch(`${origin}/api/plans/${planToken}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvedBy: "tester" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});

describe("restyleHtml", () => {
  test("replaces only the stylesheet", () => {
    const out = restyleHtml("<head><style>OLD</style></head><body>keep</body>", "NEW");
    assert.equal(out, "<head><style>NEW</style></head><body>keep</body>");
  });

  // Fail open: a styled card is a nicety, a served card is not.
  test("returns null when the anchors are missing, so the caller passes the original through", () => {
    assert.equal(restyleHtml("<head></head>", "NEW"), null);
    assert.equal(restyleHtml("<head><style>unclosed", "NEW"), null);
  });
});
