/**
 * The short-lived cookie behind `/email-settings`.
 *
 * The settings link at the foot of every notification email carries a token,
 * because a mail client cannot send an Authorization header. That much is
 * unavoidable. What used to happen next was avoidable: the token stayed in the
 * address bar of a full page somebody could sit on, so it went into browser
 * history, into a screenshot, and into whatever they pasted when they asked a
 * friend "is this really from the club?".
 *
 * So `/email-settings/<token>` is now an EXCHANGE: it hands the token to a
 * cookie and redirects to a plain `/email-settings`. The page that person then
 * reads has no credential anywhere a human can see or copy.
 *
 * The four attribute choices, and why:
 *
 * - **HttpOnly.** Nothing on the page needs to read the token, so nothing may.
 *   The two server functions read it from the request instead.
 * - **SameSite=Lax.** It has to be Lax, not Strict: the person arrives from
 *   their mail client, which is a cross-site top-level navigation, and a Strict
 *   cookie is withheld on the redirect chain that follows one. Lax is also what
 *   makes this safe to authenticate a POST with, because a cross-site POST does
 *   not carry a Lax cookie, so a page on another origin cannot flip somebody's
 *   switches for them.
 * - **Secure, on https only.** The local e2e stack and `bun run dev` serve over
 *   http, and a Secure cookie there is simply never stored, which would make the
 *   whole page untestable. The live site is https, so it gets Secure.
 * - **Path=/**, not `/email-settings`. The page itself never needs the cookie:
 *   the requests that do are the server-function RPCs, and those go to
 *   `/_serverFn/...`. Scoping the cookie to that framework-internal path would
 *   be tighter, but it would also break silently and confusingly the day the
 *   base path moved. `/` costs a HttpOnly cookie riding along on same-site
 *   requests for six hours, which is the cheaper of the two failure modes.
 *
 * The lifetime is deliberately capped, not endless. This is a signed-out
 * credential on a device we know nothing about, so it should not outlive the
 * day somebody clicked the link — six hours covers reading it on a break and
 * coming back to finish later, without becoming a session that just sits
 * there indefinitely. It expiring while the page is open is a state the page
 * renders, not an error it swallows.
 *
 * Two limits worth knowing, both deliberate:
 *
 * - **The six hours is the browser's, not ours.** The cookie carries the same
 *   token the emailed link does, and `notification_tokens` rows do not expire,
 *   so anything that copies a cookie jar wholesale (a restored backup, a
 *   profile copy, an extension) keeps working until the token is rotated.
 *   Enforcing an age server-side means signing an issued-at, which means a new
 *   server secret to configure and rotate, and it would only stop somebody who
 *   already has a credential that reads the same person's email. So the page's
 *   copy claims a page that stops saving, not a credential that expires.
 * - **The exchange can be pointed at somebody.** A cross-site link to
 *   `/email-settings/<their token>` replaces whatever settings session this
 *   browser held, so the next person to open `/email-settings` edits the
 *   linker's preferences rather than their own. It leaks nothing in the other
 *   direction, and closing it means a "yes, this is my link" click on every
 *   legitimate visit, which is the same trade `/api/verify-email/` declined.
 *
 * Everything here is pure and server-import-free, so it is unit-tested directly
 * and can be imported from a route file, a server function, or a test.
 */

/** The cookie the exchange endpoint sets and the server functions read. */
export const EMAIL_SETTINGS_COOKIE = "uts_email_settings";

/** How long the exchanged token stays usable. Six hours. */
export const EMAIL_SETTINGS_MAX_AGE_SECONDS = 6 * 60 * 60;

/** Where the exchange endpoint sends people once the cookie is set. */
export const EMAIL_SETTINGS_PATH = "/email-settings";

/**
 * The longest token we will carry.
 *
 * Tokens are `utsj_` plus 48 hex characters, so this is generous on purpose.
 * It is a guard against a huge path segment becoming a huge response header,
 * not a format check.
 */
export const MAX_EMAIL_SETTINGS_TOKEN_LENGTH = 200;

function attributes(secure: boolean): string {
  const parts = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * The `Set-Cookie` value that starts a settings session, or null when the token
 * is not something we are willing to carry.
 *
 * The value is percent-encoded rather than trusted. It arrives as a URL path
 * segment, which the router has already decoded, so a link crafted with `%0d%0a`
 * in it would otherwise put a carriage return straight into a response header.
 * `encodeURIComponent` output is always a valid cookie octet, so this is both
 * the escaping and the safety check.
 */
export function buildEmailSettingsCookie(token: string, opts: { secure: boolean }): string | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > MAX_EMAIL_SETTINGS_TOKEN_LENGTH) return null;
  const value = encodeURIComponent(trimmed);
  return `${EMAIL_SETTINGS_COOKIE}=${value}; Max-Age=${EMAIL_SETTINGS_MAX_AGE_SECONDS}; ${attributes(
    opts.secure,
  )}`;
}

/**
 * The `Set-Cookie` value that ends one.
 *
 * Used when a link cannot be exchanged. Somebody following a broken link must
 * not land on the settings of whoever used that browser before them, so the
 * failure clears rather than leaves what was there.
 */
export function clearedEmailSettingsCookie(opts: { secure: boolean }): string {
  return `${EMAIL_SETTINGS_COOKIE}=; Max-Age=0; ${attributes(opts.secure)}`;
}

/**
 * The token a request is carrying, or null.
 *
 * Null covers every way there can be no usable token: no `Cookie` header at
 * all, a header without ours in it, an emptied one, and a value whose
 * percent-encoding is malformed. The caller treats all of them the same, which
 * is what keeps the page's answer uniform.
 */
export function readEmailSettingsToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    // Compared on the whole name, so `not_uts_email_settings=...` is not a hit.
    if (pair.slice(0, eq).trim() !== EMAIL_SETTINGS_COOKIE) continue;
    const raw = pair.slice(eq + 1).trim();
    if (!raw) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    const trimmed = decoded.trim();
    if (!trimmed || trimmed.length > MAX_EMAIL_SETTINGS_TOKEN_LENGTH) return null;
    return trimmed;
  }
  return null;
}
