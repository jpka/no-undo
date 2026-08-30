/**
 * Foxit PDF assembly — HTML → PDF via the Foxit PDF Services MCP server.
 *
 * Implements build-plan.md Aug 29–30 B: replace the `tinyPdf` base64 stub in
 * `mcp/foxit/esign-adapter.mjs:createEsignFolder` with one genuine MCP call
 * (`pdf_from_html` → `get_task_result` via stdio transport) whose output bytes
 * become the `base64FileString` for `createfolder` and whose SHA-256 becomes
 * `extra.documentSha256` for the gate's digest line.
 *
 * Single-credential repro: the same FOXIT_CLIENT_ID/FOXIT_CLIENT_SECRET pair
 * (or FOXIT_CLOUD_API_CLIENT_ID/SECRET aliases) covers both PDF Services and
 * eSign; only FOXIT_CLOUD_API_HOST is PDF-specific. All reversible, all
 * unattended.
 *
 * Fixture seam: when the MCP server cannot be reached, credentials are missing,
 * or FOXIT_PDF_FIXTURE=1 / NO_FOXIT_MCP=1 is set, the assembly falls back to a
 * deterministic tiny PDF (the old stub) so CI passes without live credentials.
 * The canonical flags are NO_FOXIT_MCP and FOXIT_PDF_FIXTURE (alias);
 * FOXIT_PDF_FORCE_MCP=0 is a deprecated alias for the same. No heuristic on
 * key prefix — tests that want fixture must set an explicit flag.
 */

import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Fallback tiny PDF (1-page placeholder, same as before) -------------------
// Keeps CI green when the MCP server is unavailable. Its SHA-256 is
// precomputed so the gate's documentSha256 line remains deterministic in
// fixture mode. Note: intentionally minimal catalog stub, accepted by Foxit as
// draft but not renderable — draft-only.
export const TINY_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAw" +
  "IG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8" +
  "PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXT4+CmVuZG9iagp0" +
  "cmFpbGVyCjw8L1Jvb3QgMSAwIFI+Pg==";

export function sha256Base64(base64) {
  if (typeof base64 !== "string") {
    throw new Error("sha256Base64: invalid base64 input");
  }
  const normalized = base64.replace(/\s+/g, "");
  const buf = Buffer.from(normalized, "base64");
  const canonical = buf.toString("base64");
  if (
    normalized.length === 0 ||
    (normalized !== canonical && normalized !== canonical.replace(/=+$/, ""))
  ) {
    throw new Error("sha256Base64: invalid base64 input");
  }
  return createHash("sha256").update(buf).digest("hex");
}

export const TINY_PDF_SHA256 = sha256Base64(TINY_PDF_BASE64);

// --- HTML rendering ---------------------------------------------------------

/**
 * Render a minimal but judge-legible invoice HTML from the EsignPayload.
 * The HTML is what `pdf_from_html` rasterizes — it should look like a
 * document, not a debug dump, so the demo's "Foxit assembly" shot is credible.
 * @param {{folderName: string, recipients: Array<{firstName:string,lastName:string,email:string}>, instructions?: string|null, docSource?: string|null}} payload
 * @returns {string} HTML string
 */
export function buildInvoiceHtml(payload) {
  const title = escapeHtml(payload.folderName || "Document");
  const instructions = payload.instructions ? escapeHtml(payload.instructions) : "Prepared for signature via No Undo — reversible assembly before the gate.";
  const docSource = payload.docSource ? `<p style="color:#666;font-size:12px;">Source: ${escapeHtml(payload.docSource)}</p>` : "";
  const recipientRows = (payload.recipients || [])
    .map(
      (r) =>
        `<tr><td style="padding:8px;border:1px solid #ddd;">${escapeHtml(r.firstName)} ${escapeHtml(r.lastName)}</td><td style="padding:8px;border:1px solid #ddd;">${escapeHtml(r.email)}</td><td style="padding:8px;border:1px solid #ddd;">FILL_FIELDS_AND_SIGN</td></tr>`
    )
    .join("\n");

  // Foxit Text Tags — one required signature per party, indexed to their
  // sequence (party_number = i+1 matching esign-adapter parties.sequence).
  // Foxit converts tags to fields but does NOT remove the tag text, so we
  // render each tag in background colour (#fff on white) positioned over a
  // visible signature line. The line provides the visual cue; the hidden
  // tag provides the interactive field.
  const recipients = payload.recipients || [];
  const signatureBlocks = recipients
    .map((r, i) => {
      const seq = i + 1;
      const name = escapeHtml(`${r.firstName} ${r.lastName}`);
      const email = escapeHtml(r.email);
      // Short-form signfield tag: ${s:seq:y} or long-form ${signfield:seq:y:____}
      // Use long form for explicitness; width via trailing ____ placeholder.
      const tag = `\${signfield:${seq}:y:____}`;
      return `<div style="margin-top:24px;">
        <div style="font-size:12px;color:#333;margin-bottom:6px;">${name} — ${email}</div>
        <div style="position:relative;width:320px;height:36px;border-bottom:1px solid #111;">
          <span style="position:absolute;left:0;top:8px;color:#fff;font-size:10px;white-space:nowrap;">${tag}</span>
        </div>
        <div style="font-size:10px;color:#888;margin-top:4px;">Signature (party ${seq})</div>
      </div>`;
    })
    .join("\n");

  const signatureSection = recipients.length
    ? `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e5e5;">
    <h2 style="font-size:14px;margin:0 0 8px 0;">Signatures</h2>
    ${signatureBlocks}
  </div>`
    : "";

  // Keep styling inline so the HTML is self-contained (no external CSS fetch
  // that would time out in the 30s conversion window).
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:Inter,system-ui,Arial,sans-serif;margin:40px;color:#111;background:#fff;">
  <h1 style="font-size:22px;margin:0 0 8px 0;">${title}</h1>
  <p style="color:#555;margin:0 0 16px 0;font-size:13px;">Generated by No Undo — Foxit PDF Services (pdf_from_html) before the approval gate.</p>
  ${docSource}
  <p style="margin:16px 0 8px 0;"><strong>Instructions:</strong> ${instructions}</p>
  <h2 style="font-size:14px;margin:20px 0 8px 0;">Signers</h2>
  <table style="border-collapse:collapse;width:100%;font-size:13px;">
    <thead><tr><th style="padding:8px;border:1px solid #ddd;background:#f6f6f6;text-align:left;">Name</th><th style="padding:8px;border:1px solid #ddd;background:#f6f6f6;text-align:left;">Email</th><th style="padding:8px;border:1px solid #ddd;background:#f6f6f6;text-align:left;">Role</th></tr></thead>
    <tbody>${recipientRows}</tbody>
  </table>
  ${signatureSection}
  <p style="margin:24px 0 0 0;color:#666;font-size:11px;">This PDF was assembled reversibly via Foxit MCP before the irreversible eSign send. The gate shows its SHA-256 digest for verification.</p>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// --- MCP assembly -----------------------------------------------------------

/**
 * Call the Foxit MCP server over stdio to convert HTML → PDF and return the
 * resulting PDF bytes as base64 + its SHA-256. Falls back to TINY_PDF on any
 * transport/auth failure so CI remains green without credentials.
 *
 * Steps (per src/tools/pdf-from-html.ts workflow):
 *   1. upload_document  (fileContent base64 HTML → documentId)
 *   2. pdf_from_html    (documentId → taskId)
 *   3. get_task_result  (task_id polling → shareUrl / resultDocumentId → bytes)
 *
 * Bounded: 30s overall budget for the demo; poll with 2s interval.
 *
 * @param {{folderName:string, recipients:Array<any>, instructions?:string|null, docSource?:string|null}} payload
 * @param {{timeoutMs?:number, pollIntervalMs?:number, html?:string}} [options] - html override for tests
 * @returns {Promise<{base64:string, sha256:string, html:string, via:string}>} via = "foxit-mcp" | "fixture"
 */
export async function assemblePdf(payload, options = {}) {
  const html = options.html ?? buildInvoiceHtml(payload);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  // Fixture-seam flags: canonical NO_FOXIT_MCP and FOXIT_PDF_FIXTURE (alias);
  // FOXIT_PDF_FORCE_MCP=0 is deprecated alias. Missing credentials also forces fixture.
  const forceFixture =
    process.env.NO_FOXIT_MCP === "1" ||
    process.env.FOXIT_PDF_FIXTURE === "1" ||
    process.env.FOXIT_PDF_FORCE_MCP === "0";

  const hasCreds = Boolean(
    (process.env.FOXIT_CLIENT_ID && process.env.FOXIT_CLIENT_SECRET) ||
      (process.env.FOXIT_CLOUD_API_CLIENT_ID && process.env.FOXIT_CLOUD_API_CLIENT_SECRET)
  );

  if (forceFixture || !hasCreds) {
    return {
      base64: TINY_PDF_BASE64,
      sha256: TINY_PDF_SHA256,
      html,
      via: "fixture",
    };
  }

  // Live MCP path — bounded by timeoutMs. When hasCreds is true we fail closed:
  // any MCP error throws instead of silently returning fixture, so production
  // outages are visible. Fixture fallback only when !hasCreds or forceFixture.
  let lastError = null;

  // Resolve server entry via require.resolve (handles hoisted installs); fall back to joined path
  let serverEntry;
  try {
    const require = createRequire(import.meta.url);
    serverEntry = require.resolve("@foxitsoftware/foxit-pdf-api-mcp-server/dist/main.js");
  } catch {
    serverEntry = join(__dirname, "node_modules", "@foxitsoftware", "foxit-pdf-api-mcp-server", "dist", "main.js");
  }

  let transport = null;
  let client = null;
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const allowedEnvKeys = [
      "PATH",
      "PATHEXT",
      "HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "SYSTEMROOT",
      "SYSTEMDRIVE",
      "NODE_ENV",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TERM",
    ];
    const env = {};
    for (const k of allowedEnvKeys) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    env.FOXIT_CLOUD_API_CLIENT_ID = process.env.FOXIT_CLOUD_API_CLIENT_ID ?? process.env.FOXIT_CLIENT_ID;
    env.FOXIT_CLOUD_API_CLIENT_SECRET = process.env.FOXIT_CLOUD_API_CLIENT_SECRET ?? process.env.FOXIT_CLIENT_SECRET;
    if (process.env.FOXIT_CLOUD_API_HOST) env.FOXIT_CLOUD_API_HOST = process.env.FOXIT_CLOUD_API_HOST;

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry, "--transport", "stdio"],
      env,
    });

    client = new Client({ name: "no-undo-pdf-assembly", version: "0.1.0" });
    await client.connect(transport);

    // Deadline computed after successful connect so connect latency doesn't eat poll budget
    const deadline = Date.now() + timeoutMs;

    try {
      // 1. upload HTML
      const htmlBase64 = Buffer.from(html, "utf8").toString("base64");
      const uploadRaw = await callMcpTool(client, "upload_document", {
        fileContent: htmlBase64,
        fileName: "invoice.html",
      });
      const uploadJson = safeParseJson(uploadRaw);
      const documentId = uploadJson?.documentId || uploadJson?.document_id;
      if (!uploadJson?.success || !documentId) {
        throw new Error(`upload_document failed: ${String(uploadRaw).slice(0, 800)}`);
      }

      // 2. pdf_from_html
      const convertRaw = await callMcpTool(client, "pdf_from_html", {
        documentId,
      });
      const convertJson = safeParseJson(convertRaw);
      const taskId = convertJson?.taskId || convertJson?.task_id;
      if (!convertJson?.success || !taskId) {
        throw new Error(`pdf_from_html failed: ${String(convertRaw).slice(0, 800)}`);
      }

      // 3. poll get_task_result with bounded backoff
      let lastStatus = "working";
      while (Date.now() < deadline) {
        const statusRaw = await callMcpTool(client, "get_task_result", {
          task_id: taskId,
        });
        const statusJson = safeParseJson(statusRaw);

        const normalizedStatus = String(statusJson?.status ?? "").toLowerCase();
        const isSuccess = statusJson?.success === true || statusJson?.code === 0;

        if (normalizedStatus === "completed" && isSuccess) {
          if (statusJson.shareUrl) {
            const bytes = await fetchShareUrl(statusJson.shareUrl, deadline);
            const base64 = bytes.toString("base64");
            return { base64, sha256: sha256Base64(base64), html, via: "foxit-mcp" };
          }
          if (statusJson.resultDocumentId) {
            const tmpDir = await mkdtemp(join(tmpdir(), "no-undo-"));
            const outPath = join(tmpDir, `out-${randomUUID()}.pdf`);
            const dlRaw = await callMcpTool(client, "download_document", {
              documentId: statusJson.resultDocumentId,
              outputPath: outPath,
            });
            const dlJson = safeParseJson(dlRaw);
            // Validate server-provided outputPath is under tmpDir to avoid traversal
            const resolvedOut = dlJson?.outputPath ?? outPath;
            if (!resolvedOut.startsWith(tmpDir) && !resolvedOut.startsWith(tmpdir())) {
              throw new Error(`download_document returned unexpected path: ${resolvedOut}`);
            }
            if (dlJson?.success && dlJson?.outputPath) {
              const { readFile, unlink, rmdir } = await import("node:fs/promises");
              try {
                const bytes = await readFile(dlJson.outputPath);
                const base64 = bytes.toString("base64");
                return { base64, sha256: sha256Base64(base64), html, via: "foxit-mcp" };
              } finally {
                await unlink(dlJson.outputPath).catch(() => {});
                await rmdir(tmpDir).catch(() => {});
              }
            }
            throw new Error(`download_document failed: ${String(dlRaw).slice(0, 800)}`);
          }
          throw new Error(`get_task_result completed without shareUrl/resultDocumentId: ${String(statusRaw).slice(0, 800)}`);
        }

        if (normalizedStatus === "failed" || statusJson?.success === false) {
          throw new Error(`get_task_result failed: ${String(statusRaw).slice(0, 800)}`);
        }

        lastStatus = statusJson?.status ?? lastStatus;
        const msLeft = deadline - Date.now();
        if (msLeft <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, msLeft)));
      }

      lastError = new Error(`get_task_result polling timed out after ${timeoutMs}ms (last status: ${lastStatus})`);
      throw lastError;
    } finally {
      await client.close().catch(() => {});
    }
  } catch (e) {
    lastError = e;
    // Fail closed when creds are present and fixture not forced — surface the error
    if (hasCreds && !forceFixture) {
      console.error(`[pdf-assembly] Foxit MCP assembly failed (live credentials present): ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
    console.error(`[pdf-assembly] Foxit MCP assembly failed — falling back to fixture: ${e instanceof Error ? e.message : String(e)}`);
    return {
      base64: TINY_PDF_BASE64,
      sha256: TINY_PDF_SHA256,
      html,
      via: "fixture",
    };
  } finally {
    // Ensure transport child is reaped even if client.connect threw
    if (transport) {
      try { await transport.close(); } catch {}
    }
    // client.close already called in inner finally when connect succeeded; this is extra safety
    if (client) {
      try { await client.close().catch(()=>{}); } catch {}
    }
  }
}

async function callMcpTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`MCP tool ${name} isError: ${JSON.stringify(result.content?.slice(0, 1)).slice(0, 800)}`);
  }
  const texts = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return texts;
}

function safeParseJson(s) {
  if (!s) return null;
  const str = String(s).trim();
  // Try direct parse first (handles clean JSON)
  try { return JSON.parse(str); } catch {}
  const start = str.indexOf("{");
  const end = str.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(str.slice(start, end + 1)); } catch { return null; }
}

async function fetchShareUrl(shareUrl, deadline) {
  // Validate URL before fetching — SSRF guard
  let parsed;
  try { parsed = new URL(shareUrl); } catch { throw new Error(`invalid shareUrl: ${shareUrl}`); }
  if (parsed.protocol !== "https:") throw new Error(`shareUrl must be https, got ${parsed.protocol}`);
  // Basic host allowlist: Foxit domains / CDN. Allow any https for now but require https and block private ranges
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host.startsWith("192.168.") || host.startsWith("10.")) {
    throw new Error(`shareUrl host not allowed: ${host}`);
  }
  const msLeft = Math.max(0, deadline - Date.now());
  if (msLeft <= 0) throw new Error("shareUrl fetch timed out (deadline exceeded)");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), msLeft);
  try {
    const res = await fetch(shareUrl, { signal: controller.signal, redirect: "error" });
    if (!res.ok) throw new Error(`shareUrl fetch failed ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/html")) throw new Error(`shareUrl returned html (likely error page): ${ct}`);
    const len = res.headers.get("content-length");
    if (len && Number(len) > 20 * 1024 * 1024) throw new Error(`shareUrl too large: ${len} bytes`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error("shareUrl returned empty body");
    if (buf.length > 20 * 1024 * 1024) throw new Error(`shareUrl body too large: ${buf.length} bytes`);
    // Basic PDF magic check — warn but don't hard-fail (some PDFs may be linearized)
    if (buf.length >= 4 && buf.subarray(0, 4).toString() !== "%PDF") {
      console.error("[pdf-assembly] shareUrl body does not start with %PDF — continuing anyway");
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}
