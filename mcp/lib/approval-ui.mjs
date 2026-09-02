/**
 * Styled approval page, without forking the approval server.
 *
 * The approval card is where the agent hands an irreversible action to a
 * human, so it is worth looking considered. But `safe-write-mcp-core` owns the
 * whole page — the doctype, the `<style>` block, the card markup and the
 * approve/reject client script. A host's `renderPlan` hook returns
 * `{title, details}` and every value is HTML-escaped, so it controls content
 * and nothing else.
 *
 * The obvious fix — serve our own page — is a trap. `checkRequestProvenance`
 * pins the `Host` header against `req.socket.localPort`, so a page served from
 * a second port cannot call the core's own approve endpoint: the browser sends
 * `Origin: http://127.0.0.1:<our port>` and the core answers 403. Owning the
 * HTML therefore means reimplementing the loopback binding, the
 * Host/Origin/Sec-Fetch-Site checks, the JSON content-type gate, the body cap
 * and the audit hook — the exact security posture this project argues for.
 *
 * So we delegate instead. `createApprovalServer` returns a server that is
 * never listened on; we bind our own socket and hand each request to its
 * handler. Because the request arrives on *our* socket, `req.socket.localPort`
 * and the `Host` header still agree and every provenance check runs unchanged.
 * The only thing we touch is the CSS on the way out.
 *
 * Fails open by design: if the `<style>` anchors move in a future core
 * version, the HTML passes through untouched and the page renders with the
 * core's own styling. A styled card is a nicety; a served card is not.
 */

import http from "node:http";
import { createApprovalServer } from "safe-write-mcp-core";

const LOOPBACK = "127.0.0.1";

/** Palette lifted from docs/showcase.html so the card matches the project. */
const CSS = `
  :root {
    color-scheme: dark;
    --bg: #0d1117; --surface: #161b22; --surface-2: #1c2230;
    --border: #30363d; --fg: #e6edf3; --muted: #8b949e;
    --accent: #58a6ff; --green: #3fb950; --amber: #d29922; --red: #f85149;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; max-width: 940px; padding: 2.5rem 1.25rem 4rem;
    background: var(--bg); color: var(--fg);
    font-family: var(--sans); line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  h1 { font-size: 1.05rem; font-weight: 600; letter-spacing: .01em; margin: 0 0 .25rem; }
  .sub { color: var(--muted); font-size: .85rem; margin: 0 0 1.75rem; }
  .sub + p button { display: none; }

  .plan {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 1.5rem 1.6rem 1.35rem; margin: 0 0 1.25rem;
  }
  .plan header {
    display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 1px solid var(--border); padding-bottom: .75rem; margin-bottom: .25rem;
  }
  .badge { background: none; color: var(--muted); font-weight: 500; font-size: .8rem; padding: 0; }
  .expiry { color: var(--muted); font-size: .8rem; font-variant-numeric: tabular-nums; }
  .plan h2 { font-size: 1.35rem; font-weight: 600; margin: .9rem 0 1.1rem; }

  dl { display: grid; grid-template-columns: 12.5rem minmax(0, 1fr); gap: 0 1.5rem; margin: 0; }
  dt {
    font-weight: 500; font-size: .78rem; text-transform: uppercase;
    letter-spacing: .06em; color: var(--muted);
    padding: .7rem 0 0; margin: 0; border-top: 1px solid var(--border);
  }
  dd { margin: 0; padding: .7rem 0 0; border-top: 1px solid var(--border); min-width: 0; }
  dl > dt:first-of-type, dl > dt:first-of-type + dd { border-top: none; padding-top: 0; }
  pre {
    background: none; padding: 0; margin: 0; border-radius: 0;
    font-family: var(--mono); font-size: .9rem; line-height: 1.5; color: var(--fg);
  }
  dd em { color: var(--muted); font-style: normal; }

  .actions {
    display: flex; gap: .6rem; margin-top: 1.6rem;
    padding-top: 1.25rem; border-top: 1px solid var(--border); flex-wrap: wrap;
  }
  .actions input {
    flex: 1; min-width: 11rem; padding: .5rem .7rem; font-family: var(--sans); font-size: .9rem;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .actions input::placeholder { color: var(--muted); }
  /* Equal weight, deliberately. A dominant green CTA on a page whose whole
     purpose is a considered decision would be arguing for one answer. */
  button {
    padding: .5rem 1.25rem; border-radius: 6px; font-weight: 600; font-size: .9rem;
    font-family: var(--sans); cursor: pointer;
    background: var(--surface-2); border: 1px solid var(--border); color: var(--fg);
  }
  button.approve { background: var(--surface-2); border-color: var(--green); color: var(--green); }
  button.reject  { background: var(--surface-2); border-color: var(--red);   color: var(--red); }
  button:disabled { opacity: .45; cursor: default; }
  #status { margin: .5rem 0; min-height: 1.2rem; color: var(--amber); font-size: .9rem; }
  .empty { color: var(--muted); font-style: normal; }
`;

/**
 * Swap the page's stylesheet. Returns null when the anchors aren't found, so
 * the caller can pass the original through rather than serve a broken page.
 * @param {string} html
 * @param {string} css
 * @returns {string|null}
 */
export function restyleHtml(html, css = CSS) {
  const open = html.indexOf("<style>");
  if (open === -1) return null;
  const close = html.indexOf("</style>", open);
  if (close === -1) return null;
  return html.slice(0, open + "<style>".length) + css + html.slice(close);
}

/** Case-insensitive header lookup over the object form of writeHead(). */
function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() === wanted) return String(headers[key]);
  }
  return "";
}

function headerKey(headers, name) {
  const wanted = name.toLowerCase();
  return Object.keys(headers ?? {}).find((k) => k.toLowerCase() === wanted) ?? name;
}

/**
 * Defer the response head so the body can be rewritten before Content-Length
 * is committed. The core always writes `writeHead(status, headers)` then
 * `end(body)`; anything else (a streamed `write()`) flushes the head untouched
 * and passes straight through.
 * @param {import("node:http").ServerResponse} res
 * @param {string} css
 */
function interceptHtml(res, css) {
  const writeHead = res.writeHead.bind(res);
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  /** @type {{status: number, headers: Record<string, any>}|null} */
  let held = null;
  let streaming = false;

  res.writeHead = (status, headers) => {
    if (streaming || typeof headers !== "object" || headers === null) {
      return writeHead(status, headers);
    }
    held = { status, headers: { ...headers } };
    return res;
  };

  res.write = (...args) => {
    if (held && !streaming) {
      streaming = true;
      writeHead(held.status, held.headers);
      held = null;
    }
    return write(...args);
  };

  res.end = (body, ...rest) => {
    if (!held) return end(body, ...rest);
    const { status, headers } = held;
    held = null;
    if (typeof body === "string" && headerValue(headers, "content-type").startsWith("text/html")) {
      const styled = restyleHtml(body, css);
      if (styled !== null) {
        body = styled;
        headers[headerKey(headers, "content-length")] = Buffer.byteLength(body);
      }
    }
    writeHead(status, headers);
    return end(body, ...rest);
  };
  return res;
}

/**
 * Drop-in replacement for `startApprovalServer` that serves the same page with
 * this project's styling. Same signature, same handle shape.
 *
 * @param {any} store
 * @param {any} [options] - passed through to createApprovalServer untouched
 * @returns {Promise<{server: import("node:http").Server, port: number, host: string, close(): Promise<void>}>}
 */
export async function startStyledApprovalServer(store, options = {}) {
  const core = createApprovalServer(store, options);
  const server = http.createServer((req, res) => {
    // Delegating on our own socket is the whole point: localPort and the Host
    // header still agree, so the core's provenance checks are unchanged.
    core.emit("request", req, interceptHtml(res, CSS));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK, () => {
      server.removeListener("error", reject);
      resolve(undefined);
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    port,
    host: LOOPBACK,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
      }),
  };
}
