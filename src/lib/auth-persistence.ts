import { supabase } from "@/integrations/supabase/client";

/**
 * "Remember me" persistence.
 *
 * The generated Supabase client always persists the auth session to
 * `localStorage`, so by default a signed-in user is remembered across full
 * browser restarts. Since that client is auto-generated we implement the
 * opt-out ("don't remember me") in app code instead of changing its storage.
 *
 * When a user signs in we record their choice:
 *   - `localStorage[REMEMBER_STORAGE_KEY]` — the durable preference.
 *   - `sessionStorage[SESSION_ACTIVE_KEY]`  — a per-browser-session marker that
 *     is wiped automatically when the browser session ends.
 *
 * On app load, if the user opted out AND the session marker is gone, the
 * browser was restarted, so we discard the persisted session.
 */

export const REMEMBER_STORAGE_KEY = "uts-jitsu.auth.remember";
export const SESSION_ACTIVE_KEY = "uts-jitsu.auth.session-active";

/**
 * Decide whether a persisted session should be discarded on app load.
 *
 * Returns `true` only when the user explicitly opted out of being remembered
 * (`remember === "false"`) and the current browser session marker is absent
 * (`sessionActive === null`), meaning the browser was restarted since sign-in.
 * A missing preference (e.g. existing users, or "remember me" left on) keeps
 * the session, preserving the client's default behaviour.
 */
export function shouldForgetSession(
  remember: string | null,
  sessionActive: string | null,
): boolean {
  return remember === "false" && sessionActive === null;
}

/**
 * Whether `href` is the landing URL of a Supabase auth email link (sign-in,
 * invite or password recovery).
 *
 * Supabase puts the tokens in the URL fragment for email links, and a PKCE
 * `code` in the query string for the exchange flow. Either way a session that
 * exists during such a page load was created *by that link*, in this tab.
 *
 * This matters because email links open in a fresh tab, where `sessionStorage`
 * is always empty, which looks identical to "the browser was restarted". Left
 * unchecked, a user who once unchecked "Keep me signed in" would be signed
 * straight back out by the very link that just signed them in.
 */
export function isAuthCallbackUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  return (
    fragment.has("access_token") ||
    fragment.has("error") ||
    fragment.has("error_code") ||
    url.searchParams.has("code") ||
    url.searchParams.has("token_hash")
  );
}

/** Record the user's "remember me" choice at sign-in time (client only). */
export function rememberSession(remember: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(REMEMBER_STORAGE_KEY, remember ? "true" : "false");
  sessionStorage.setItem(SESSION_ACTIVE_KEY, "1");
}

/**
 * Honour a previous "don't remember me" choice on app start by clearing a
 * session that outlived its browser session, then (re)mark this browser
 * session as active so in-session reloads keep the user signed in.
 *
 * `initialHref` must be the URL as it was when the page loaded. The caller has
 * to capture it up front, because the Supabase client strips an email link's
 * tokens out of the address bar as soon as it initialises, which is well
 * before this runs.
 */
export function applyRememberPreference(initialHref: string): void {
  if (typeof window === "undefined") return;
  const remember = localStorage.getItem(REMEMBER_STORAGE_KEY);
  const sessionActive = sessionStorage.getItem(SESSION_ACTIVE_KEY);

  if (!isAuthCallbackUrl(initialHref) && shouldForgetSession(remember, sessionActive)) {
    // `scope: "local"` clears the stored session without a network round-trip.
    void supabase.auth.signOut({ scope: "local" });
    localStorage.removeItem(REMEMBER_STORAGE_KEY);
  }

  sessionStorage.setItem(SESSION_ACTIVE_KEY, "1");
}
