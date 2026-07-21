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
 */
export function applyRememberPreference(): void {
  if (typeof window === "undefined") return;
  const remember = localStorage.getItem(REMEMBER_STORAGE_KEY);
  const sessionActive = sessionStorage.getItem(SESSION_ACTIVE_KEY);

  if (shouldForgetSession(remember, sessionActive)) {
    // `scope: "local"` clears the stored session without a network round-trip.
    void supabase.auth.signOut({ scope: "local" });
    localStorage.removeItem(REMEMBER_STORAGE_KEY);
  }

  sessionStorage.setItem(SESSION_ACTIVE_KEY, "1");
}
