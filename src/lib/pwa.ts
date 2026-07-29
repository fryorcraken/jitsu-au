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

export type LaunchState = {
  /** Whether the Supabase client resolved a live session on this device. */
  hasSession: boolean;
};

/** The screens the installed app can open on. */
export type LaunchScreen = "member" | "home";

/**
 * The screen the installed app should open on.
 *
 * Signed in goes straight to the member area. Everyone else gets the public
 * home page: there is no self-serve sign-up, so a sign-in screen would be a
 * dead end for a prospective member, and a member who is signed out can reach
 * "Member login" from the home page header in one tap.
 */
export function resolveLaunchScreen({ hasSession }: LaunchState): LaunchScreen {
  return hasSession ? "member" : "home";
}
