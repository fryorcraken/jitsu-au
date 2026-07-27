// Site-wide password gate for the not-yet-launched site.
//
// This is a "please don't mistake this for the live club site" screen, not a
// security control: one shared password, an obfuscated cookie, no user accounts.
// Anything that actually needs protecting is still behind Supabase auth and RLS.
//
// The gate only turns on when the SITE_PASSWORD env var is set, so local dev,
// tests and CI run ungated by default. Wiring lives in `src/start.ts`.

/** Cookie that remembers a visitor already typed the password. */
export const SITE_GATE_COOKIE = "uts_site_access";

/** Path the unlock form posts to. Deliberately not a real route. */
export const SITE_GATE_PATH = "/__site-access";

/** How long an unlocked visitor stays unlocked (30 days). */
export const SITE_GATE_MAX_AGE = 60 * 60 * 24 * 30;

// Machine callers that carry their own credentials and can't be shown a form:
// the manager agent API (bearer token) and the Supabase auth email webhook.
const EXEMPT_PREFIXES = ["/api/", "/lovable/email/"];

export function isGateExempt(pathname: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * A short, stable stamp of the password, so the cookie doesn't carry the
 * password itself. djb2, not a cryptographic hash. Good enough for a gate that
 * only has to stop casual visitors.
 */
export function gateStamp(password: string): string {
  let hash = 5381;
  for (let i = 0; i < password.length; i++) {
    hash = ((hash * 33) ^ password.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function buildGateCookie(value: string, secure: boolean): string {
  const attrs = [
    `${SITE_GATE_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SITE_GATE_MAX_AGE}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Keep post-unlock redirects on this site: same-origin absolute paths only. */
export function safeRedirectPath(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderGatePage(options: { redirectTo: string; failed?: boolean }): string {
  const redirectTo = escapeHtml(safeRedirectPath(options.redirectTo));
  const error = options.failed
    ? `<p class="error">That password isn't right. Have another go.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>UTS Jitsu</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <style>
      body { font: 15px/1.5 system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 22rem; width: 100%; text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: #4b5563; margin: 0 0 1.5rem; }
      .error { color: #b91c1c; margin: 0 0 1rem; }
      form { display: flex; flex-direction: column; gap: 0.5rem; }
      input, button { padding: 0.5rem 0.75rem; border-radius: 0.375rem; font: inherit; border: 1px solid #d1d5db; }
      button { background: #111; color: #fff; border-color: transparent; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>UTS Jitsu</h1>
      <p>This site isn't live yet. If you have the password, you can take a look.</p>
      ${error}
      <form method="post" action="${SITE_GATE_PATH}">
        <input type="hidden" name="redirect" value="${redirectTo}" />
        <input
          type="password"
          name="password"
          aria-label="Password"
          placeholder="Password"
          autocomplete="current-password"
          autofocus
          required
        />
        <button type="submit">Let me in</button>
      </form>
    </div>
  </body>
</html>`;
}
