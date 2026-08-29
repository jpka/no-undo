/**
 * Plain-prompt parser — turns a single natural-language line into the typed
 * EsignPayload that agent/esign-agent-loop.mjs already consumes.
 *
 * Pipeline step 0 (build-plan.md Aug 29-30 A): the only entry point a judge
 * needs is one line like
 *   "Take this freight invoice, redact the PII, and send it to Alice and Bob for signature."
 * This parser extracts {folderName, recipients, docSource, instructions} into
 * the shape runAgentLoop expects. The parsed fields are echoed back in the
 * approval card for human correction before any irreversible step.
 *
 * Strategy: deterministic regex extraction first (no live LLM in CI). An LLM
 * hook is stubbed for future use — if process.env.OPENAI_API_KEY is set and
 * regex extraction is ambiguous, callers may opt in via parsePromptLlm, which
 * must still validate through the same zod schema and fall back to regex on
 * any failure. The default parsePrompt never touches the network.
 */

import { z } from "zod";

// --- Zod schemas -------------------------------------------------------------

export const RecipientSchema = z.object({
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
  email: z.string().email(),
  // `true` when the email was explicitly provided (in the prompt or via
  // --recipient); `false` when synthesized from a name match or the
  // Alice/Bob fallback. The live send path refuses unresolved recipients.
  resolved: z.boolean().default(true),
});
export const ParsedPromptSchema = z.object({
  folderName: z.string().min(1).max(200),
  recipients: z.array(RecipientSchema).min(1).max(10),
  docSource: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  promptExcerpt: z.string().max(200),
});

export const parseRecipient = (r) => RecipientSchema.parse(r);
export const parseParsedPrompt = (p) => ParsedPromptSchema.parse(p);

// --- Constants ---------------------------------------------------------------

const MAX_PROMPT_LENGTH = 10_000;
const MAX_EXCERPT_LENGTH = 120;

// --- Regex extraction ---------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const KNOWN_NAMES = [
  { first: "Alice", last: "Smith" },
  { first: "Bob", last: "Jones" },
  { first: "Carol", last: "Taylor" },
  { first: "Dave", last: "Brown" },
  { first: "Eve", last: "Davis" },
  { first: "Frank", last: "Miller" },
  { first: "Grace", last: "Wilson" },
  { first: "Heidi", last: "Moore" },
  { first: "Ivan", last: "Taylor" },
  { first: "Judy", last: "Anderson" },
];

function deriveNameFromEmail(email) {
  const local = email.split("@")[0];
  const parts = local.split(/[._-]+/);
  if (parts.length >= 2) {
    return {
      firstName: capitalize(parts[0]),
      lastName: capitalize(parts[1]),
    };
  }
  return { firstName: capitalize(local), lastName: "Signer" };
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractRecipients(prompt) {
  const rawEmails = [...prompt.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase());
  const emails = [...new Set(rawEmails)];
  if (emails.length > 0) {
    return emails.map((email) => {
      const { firstName, lastName } = deriveNameFromEmail(email);
      return { firstName, lastName, email, resolved: true };
    });
  }
  const named = extractNamedRecipients(prompt);
  if (named.length > 0) return named;
  return [
    { firstName: "Alice", lastName: "Signer", email: "alice@example.com", resolved: false },
    { firstName: "Bob", lastName: "Signer", email: "bob@example.com", resolved: false },
  ];
}

function extractNamedRecipients(prompt) {
  const found = [];
  for (const n of KNOWN_NAMES) {
    const re = new RegExp(`\\b${n.first}\\b`, "i");
    if (re.test(prompt)) {
      found.push({ firstName: n.first, lastName: n.last, email: `${n.first.toLowerCase()}@example.com`, resolved: false });
    }
  }
  return found;
}

function extractFolderName(prompt) {
  const quoted = prompt.match(/["']([^"']{1,100})["']/);
  if (quoted) return quoted[1].trim();
  const lower = prompt.toLowerCase();
  if (lower.includes("freight invoice")) return "Freight Invoice";
  if (lower.includes("invoice")) return "Invoice";
  if (lower.includes("contract")) return "Contract";
  if (lower.includes("agreement")) return "Agreement";
  if (lower.includes("proposal")) return "Proposal";
  if (lower.includes("offer letter")) return "Offer Letter";
  if (lower.includes("nda")) return "NDA";
  if (lower.includes("purchase order")) return "Purchase Order";
  const cleaned = prompt.replace(/^(take|send|please|kindly)\s+/i, "").trim();
  if (cleaned.length <= 40) return cleaned;
  const truncated = cleaned.slice(0, 40).trim();
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > 20) return truncated.slice(0, lastSpace) + "…";
  return truncated + "…";
}

function extractDocSource(prompt) {
  const pdfMatch = prompt.match(/([a-zA-Z0-9_-]+\.pdf)/i);
  if (pdfMatch) return pdfMatch[1];
  return null;
}

function extractInstructions(prompt) {
  const parts = [];
  if (/\bredact(ion|ing|ed)?\b/i.test(prompt)) parts.push("redact PII");
  if (/\bsign(ature|ing)?\b/i.test(prompt)) parts.push("send for signature");
  if (/\breview\b/i.test(prompt)) parts.push("review required");
  return parts.length > 0 ? parts.join("; ") : null;
}

function makeExcerpt(prompt) {
  if (prompt.length <= MAX_EXCERPT_LENGTH) return prompt;
  return prompt.slice(0, MAX_EXCERPT_LENGTH).trimEnd() + "…";
}

// --- Public API ---------------------------------------------------------------

export function parsePrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("parsePrompt: prompt must be a non-empty string");
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`parsePrompt: prompt exceeds max length of ${MAX_PROMPT_LENGTH}`);
  }
  const recipients = extractRecipients(prompt);
  const parsed = {
    folderName: extractFolderName(prompt),
    recipients,
    docSource: extractDocSource(prompt),
    instructions: extractInstructions(prompt),
    promptExcerpt: makeExcerpt(prompt),
  };
  return parseParsedPrompt(parsed);
}

/**
 * LLM-backed prompt parser (stub). The build plan describes an LLM fallback
 * for ambiguous prompts. This is not yet implemented — it delegates to
 * parsePrompt. When implemented, it must validate through ParsedPromptSchema
 * and fall back to regex on any LLM failure.
 * @param {string} prompt
 * @returns {Promise<ParsedPrompt>}
 */
export async function parsePromptLlm(prompt) {
  return parsePrompt(prompt);
}

export function isValidPrompt(prompt) {
  try {
    parsePrompt(prompt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a --recipient flag value ("Name <email>" or bare "email") into a
 * resolved recipient. These override any synthesized addresses from the
 * prompt parser. Throws on malformed input so the CLI fails fast.
 * @param {string} flag
 * @returns {{firstName: string, lastName: string, email: string, resolved: true}}
 */
export function parseRecipientFlag(flag) {
  if (typeof flag !== "string" || !flag.trim()) {
    throw new Error("parseRecipientFlag: empty recipient");
  }
  const m = flag.match(/^\s*([^<]+?)\s*<([^>]+)>\s*$/);
  if (m) {
    const email = m[2].trim().toLowerCase();
    const name = m[1].trim();
    const parts = name.split(/\s+/);
    const firstName = parts[0] || "Signer";
    const lastName = parts.slice(1).join(" ") || "Signer";
    RecipientSchema.parse({ firstName, lastName, email, resolved: true });
    return { firstName, lastName, email, resolved: true };
  }
  // Bare email
  const email = flag.trim().toLowerCase();
  RecipientSchema.parse({ firstName: "Signer", lastName: "Signer", email, resolved: true });
  const { firstName, lastName } = deriveNameFromEmail(email);
  return { firstName, lastName, email, resolved: true };
}

/**
 * Merge explicit --recipient overrides with parsed recipients. If overrides
 * are provided, they fully replace the parsed list (the user is telling us
 * exactly who to send to — the parser's guesses are irrelevant). Without
 * overrides, parsed recipients pass through unchanged (and may include
 * unresolved entries, which the send path will refuse).
 * @param {Array} parsed
 * @param {Array} overrides
 * @returns {Array}
 */
export function mergeRecipients(parsed, overrides = []) {
  if (overrides.length > 0) return overrides;
  return parsed;
}
