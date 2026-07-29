/**
 * Installed-app (PWA) behaviour.
 *
 * Side-effect free and server-import free, so the launch rule can be unit
 * tested without a browser or a router.
 */

/**
 * Where the installed app opens. It matches `start_url` in
 * `public/manifest.webmanifest`; the route it names does nothing but work out
 * which screen you should actually be looking at and send you there.
 */
export const PWA_LAUNCH_PATH = "/app";

/** The member area: what someone signed in wants to see on launch. */
export const MEMBER_HOME_PATH = "/account";

/**
 * Set on a device once someone has been signed in there.
 *
 * Tapping the icon is a stronger signal of intent than opening the website, so
 * a member whose session has lapsed gets the sign-in screen rather than the
 * marketing home page. Someone who installed the app but has never had an
 * account (there is no self-serve sign-up, so that is the common case for a
 * prospective member) must not be dropped on a sign-in form they cannot use.
 */
export const KNOWN_MEMBER_KEY = "uts-jitsu.pwa.known-member";

export type LaunchState = {
  /** Whether the Supabase client resolved a live session on this device. */
  hasSession: boolean;
  /** Whether this device has ever had someone signed in. */
  hasSignedInBefore: boolean;
};

/** The screens the installed app can open on. */
export type LaunchScreen = "member" | "sign-in" | "home";

/**
 * The screen the installed app should open on.
 *
 * - Signed in, so straight to the member area.
 * - Signed out on a device that has had a member on it, so the sign-in screen,
 *   set up to continue into the member area.
 * - Anyone else gets the public home page.
 */
export function resolveLaunchScreen({ hasSession, hasSignedInBefore }: LaunchState): LaunchScreen {
  if (hasSession) return "member";
  if (hasSignedInBefore) return "sign-in";
  return "home";
}

/** Whether this device has ever had someone signed in (client only). */
export function hasSignedInBefore(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(KNOWN_MEMBER_KEY) === "1";
  } catch {
    // Private-mode Safari and blocked storage both throw here. Not knowing is
    // the same as never having signed in, which is the safe default.
    return false;
  }
}

/** Remember that someone has been signed in on this device (client only). */
export function rememberSignedIn(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KNOWN_MEMBER_KEY, "1");
  } catch {
    // Nothing to do: the launch screen just falls back to the home page.
  }
}
