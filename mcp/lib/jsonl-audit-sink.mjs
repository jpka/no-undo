// Hash-chained JSONL audit sink for safe-write hosts.
//
// The core's AuditSink contract (safe-write-mcp-core src/audit.ts) requires
// record() to be synchronous and never throw: async persistence would escape
// the core's error handling. So this sink appends with writeSync + fsyncSync,
// the same discipline as the core's journal, and swallows + reports its own
// write failures on stderr. A failed audit append must never take down a plan
// transition; it degrades the trail, not the gate.
//
// Each line is one AuditEvent plus chain fields:
//   { ...event, prevHash, hash }
// where hash = sha256(prevHash || canonical-json(event)) and prevHash is the
// previous line's hash ("0"*64 at genesis). On construction the head is
// recovered from the last COMPLETE line, so a restart continues the same
// chain instead of starting a parallel one. A trailing partial line (a crash
// mid-write) is ignored for recovery and reported by verify() as tornTail.
//
// The events carry no payloads — only tokens, statuses, tools and reasons —
// so the file is safe to screen-record and safe to commit as a fixture.
// That is deliberate: the journal is the file a judge must never see raw
// (it carries full payloads); this is the file they may.

import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fchmodSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export const GENESIS_HASH = "0".repeat(64);

function eventHash(prevHash, event) {
  return createHash("sha256").update(prevHash).update(JSON.stringify(event)).digest("hex");
}

function writeAll(fd, data) {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) throw new Error(`writeSync made no progress (${written} bytes)`);
    offset += written;
  }
}

/**
 * Recover the chain head from the last complete line of an existing audit
 * file. Reads only a bounded tail window, not the whole file. Returns
 * { head, completeLines, tornTail, validBytes } — validBytes is the length
 * of the file up to and including the last complete line, i.e. the size a
 * recovering writer should truncate to before appending — or null when the
 * file does not exist / is empty.
 */
export function recoverHead(path, windowBytes = 64 * 1024) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size === 0) return { head: GENESIS_HASH, completeLines: 0, tornTail: false, validBytes: 0 };

  // Widen the window until it contains at least one newline, so a pathological
  // tail of one huge partial write cannot hide every complete line.
  let start = Math.max(0, size - windowBytes);
  let buf;
  for (;;) {
    buf = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    if (buf.indexOf(0x0a) !== -1 || start === 0) break;
    start = Math.max(0, start - windowBytes);
  }

  const text = buf.toString("utf8");
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  // A window that starts mid-file begins with a partial line; drop it.
  if (start > 0 && lines.length > 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  // A trailing chunk without a newline never made it to disk whole — the
  // writer emits line + newline in one writeSync and fsyncs after, so its
  // bytes cannot be trusted. Exclude it from the count and from head
  // recovery entirely.
  if (!endsWithNewline && lines.length > 0) lines.pop();
  const tornTail = !endsWithNewline;

  // Byte offset just past the last complete line: everything a restarted
  // writer may safely keep.
  let validBytes = size;
  if (tornTail) {
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      validBytes = 0; // no complete line anywhere in the window
      lines.length = 0;
    } else {
      // Convert the window-relative offset back into a file offset.
      validBytes = start + Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");
    }
  }

  let head = GENESIS_HASH;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (typeof rec?.hash === "string") head = rec.hash;
    } catch {
      process.stderr.write(
        `jsonl-audit-sink(${path}): unparseable line in tail ignored during head recovery\n`,
      );
    }
  }
  return { head, completeLines: lines.length, tornTail, validBytes };
}

/**
 * Create a hash-chained append-only JSONL audit sink.
 * @param {string} path
 * @returns {{
 *   path: string,
 *   record: (event: object) => undefined,
 *   head: () => string,
 *   lines: () => number,
 * }}
 */
export function createJsonlAuditSink(path) {
  let existed = true;
  try {
    existed = statSync(path).isFile();
  } catch {
    existed = false;
  }
  const fd = openSync(path, "a", 0o600);
  if (!existed) {
    fchmodSync(fd, 0o600);
    // fsync the parent directory so a fresh file survives a power loss,
    // mirroring the core journal's discipline.
    try {
      const dirFd = openSync(dirname(path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (err) {
      process.stderr.write(
        `jsonl-audit-sink(${path}): could not fsync parent directory: ${String(err)}\n`,
      );
    }
  }

  const recovered = recoverHead(path);

  // A torn tail must be removed before anything appends after it: those bytes
  // were never fsync'd as a unit, and appending a fresh record onto them would
  // weld the new record to crash debris. Truncate to the last complete line —
  // the same recovery rule a journal replays by.
  if (recovered?.tornTail) {
    try {
      ftruncateSync(fd, recovered.validBytes);
      process.stderr.write(
        `jsonl-audit-sink(${path}): truncated torn tail to ${recovered.validBytes} bytes ` +
          `(last complete line kept)\n`,
      );
      recovered.tornTail = false;
    } catch (err) {
      process.stderr.write(`jsonl-audit-sink(${path}): could not truncate torn tail: ${String(err)}\n`);
    }
  }

  return {
    path,
    head: () => recovered?.head ?? GENESIS_HASH,
    lines: () => recovered?.completeLines ?? 0,
    record(event) {
      try {
        const prevHash = recovered?.head ?? GENESIS_HASH;
        const hash = eventHash(prevHash, event);
        const record = { ...event, prevHash, hash };
        const line = JSON.stringify(record) + "\n";
        writeAll(fd, line);
        fsyncSync(fd);
        if (recovered) {
          recovered.head = hash;
          recovered.completeLines += 1;
          recovered.tornTail = false;
        }
      } catch (err) {
        process.stderr.write(`jsonl-audit-sink(${path}): append failed: ${String(err)}\n`);
      }
      return undefined;
    },
  };
}

/**
 * Verify the hash chain of an audit JSONL file by streaming it. Never loads
 * the whole file. Tolerates exactly one trailing partial line (a crash
 * mid-write leaves a final chunk without a newline) and reports it as
 * tornTail rather than failing on it; an unparseable line anywhere else is a
 * broken chain.
 * @param {string} path
 * @returns {Promise<{ok: boolean, lines: number, brokenAt?: number, reason?: string, tornTail?: boolean}>}
 */
export function verifyAuditChain(path) {
  return new Promise((resolve) => {
    let endsWithNewline = false;
    try {
      const size = statSync(path).size;
      if (size > 0) {
        const fd = openSync(path, "r");
        try {
          const last = Buffer.alloc(1);
          readSync(fd, last, 0, 1, size - 1);
          endsWithNewline = last[0] === 0x0a;
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      // Stat/read failures fall through to the stream's own error handling.
    }

    let expectedPrev = GENESIS_HASH;
    let index = 0;
    let pending = null; // one-line lookahead: the true tail is only known at close

    const checkLine = (line) => {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return { ok: false, lines: index, brokenAt: index, reason: "unparseable line" };
      }
      if (rec.prevHash !== expectedPrev) {
        return {
          ok: false,
          lines: index,
          brokenAt: index,
          reason: `prevHash mismatch: expected ${expectedPrev.slice(0, 12)}…, got ${String(rec.prevHash).slice(0, 12)}…`,
        };
      }
      const { prevHash, hash, ...event } = rec;
      if (eventHash(prevHash, event) !== hash) {
        return { ok: false, lines: index, brokenAt: index, reason: "hash mismatch" };
      }
      expectedPrev = hash;
      index += 1;
      return null;
    };

    const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
    rl.on("line", (line) => {
      if (line === "") return;
      if (pending !== null) {
        const failure = checkLine(pending);
        if (failure) {
          rl.close();
          resolve(failure);
          return;
        }
      }
      pending = line;
    });
    rl.on("close", () => {
      if (pending !== null && endsWithNewline) {
        const failure = checkLine(pending);
        if (failure) {
          resolve(failure);
          return;
        }
        resolve({ ok: true, lines: index });
        return;
      }
      if (pending !== null) {
        // No trailing newline: the last chunk never made it to disk whole.
        resolve({ ok: true, lines: index, tornTail: true });
        return;
      }
      resolve({ ok: true, lines: index });
    });
    rl.on("error", (err) => resolve({ ok: false, lines: index, reason: String(err) }));
  });
}

/**
 * Fan one event out to several sinks (e.g. the stderr console line a human
 * watches plus the durable JSONL chain). One sink failing never blocks the
 * others; per-sink errors are the sinks' own responsibility to report.
 * @param {...{record: (event: object) => undefined}} sinks
 */
export function compositeSink(...sinks) {
  return {
    record(event) {
      for (const sink of sinks) {
        try {
          sink.record(event);
        } catch (err) {
          process.stderr.write(`compositeSink: member sink failed: ${String(err)}\n`);
        }
      }
      return undefined;
    },
  };
}

/**
 * Default audit-file path derived from a journal path: sits beside it, named
 * after the stage. Returns null when there is no journal path — callers then
 * keep whatever non-durable sink they had.
 * @param {string | undefined} journalPath
 * @param {string} stageName
 * @param {string} [overridePath]
 * @returns {string | null}
 */
export function defaultAuditPath(journalPath, stageName, overridePath) {
  if (overridePath) return overridePath;
  if (!journalPath) return null;
  return join(dirname(journalPath), `${stageName}-audit.jsonl`);
}
