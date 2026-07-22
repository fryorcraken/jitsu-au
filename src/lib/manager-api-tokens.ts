// Pure, server-import-free helpers for manager API tokens.
//
// Tokens authenticate the manager agent API (/api/manager/agent). We never store
// the raw token — only its SHA-256 hash — so these helpers cover generation,
// hashing, display masking, and the copy-paste agent onboarding prompt. All are
// unit-testable; the DB access lives in manager-api-tokens.functions.ts.

/** Human-recognisable prefix so a token is obviously ours and easy to spot. */
export const API_TOKEN_PREFIX = "utsj_";

/** Chars of the token (incl. prefix) kept as the non-secret display label. */
export const TOKEN_PREVIEW_LEN = API_TOKEN_PREFIX.length + 8;

/** Access the platform Web Crypto implementation (Workers, Node 20+, jsdom). */
function webCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("Web Crypto is not available in this runtime.");
  return c;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** A fresh random token: `utsj_` + 48 hex chars (24 bytes of entropy). */
export function generateRawToken(): string {
  const bytes = new Uint8Array(24);
  webCrypto().getRandomValues(bytes);
  return API_TOKEN_PREFIX + toHex(bytes);
}

/** SHA-256 hex digest of a raw token — this is what we persist and look up by. */
export async function hashToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const digest = await webCrypto().subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

/** The non-secret prefix stored for display (e.g. `utsj_1a2b3c4d`). */
export function tokenPreview(raw: string): string {
  return raw.slice(0, TOKEN_PREVIEW_LEN);
}

/**
 * The copy-paste prompt a manager gives their coding agent (Claude Code,
 * opencode, Cursor, …). It teaches the agent to read the live manifest first,
 * so it never hard-codes an action list, and it deliberately keeps the token in
 * an env var rather than inline. `baseUrl` is the site origin, e.g.
 * "https://jitsu.au".
 */
export function buildAgentPrompt(opts: { baseUrl: string }): string {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}/api/manager/agent`;
  return `You help a manager of UTS Jitsu (a Sydney jiu-jitsu club) run back-office tasks
through the club's Manager Agent API.

API endpoint: ${endpoint}
Auth: every request must include the header
  Authorization: Bearer $UTS_MANAGER_API_KEY
Store the token I give you as the UTS_MANAGER_API_KEY environment variable.
Never print, log, or commit it.

How to use it:
1. First GET ${endpoint} to read the manifest — the authoritative list of
   actions and their parameters. Always trust the manifest over any list below.
2. Then call an action with POST ${endpoint} and a JSON body:
     {"action": "<name>", "params": { ... }}
   Responses are {"ok": true, "result": ...} or {"ok": false, "error": {...}}.

Actions (as of now — confirm against the manifest):
- list_users     — members and their status (lifecycle, roles, invoices)
- list_invoices  — invoices (membership payment records); use to find an id
- edit_invoice   — correct an invoice: price_cents, notes, payment_reference,
                   payment_method, status

Rules:
- Confirm the member's name and the amount with me before editing an invoice.
- You cannot set an invoice's status to "active" — activation runs through bank
  reconciliation, not this API.

Example:
  curl -s "${endpoint}" -H "Authorization: Bearer $UTS_MANAGER_API_KEY"
  curl -s "${endpoint}" -H "Authorization: Bearer $UTS_MANAGER_API_KEY" \\
    -H "content-type: application/json" \\
    -d '{"action":"list_users","params":{"status":"member"}}'`;
}
