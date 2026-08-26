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

/* ---------------- Picking up where you left off ---------------- */

/**
 * How long a recorded location is worth returning to.
 *
 * The problem this solves: a phone reclaims the installed app in the
 * background, and the next tap on the icon is not a resume, it is a cold launch
 * at `start_url`. So somebody who was half-way through an article, or reading
 * the roster for tonight's class, comes back to the member home page with no
 * sign that anything was lost. To them it looks like the app reloaded itself.
 *
 * A day, because that is the span over which "I was just looking at this" is
 * still true. Beyond it, the member area is the more useful answer than
 * whatever screen happened to be open last week.
 */
export const LAUNCH_RESUME_WINDOW_MS = 24 * 60 * 60_000;

/** Where the app was, and who it was for, the last time anybody looked. */
export type LastVisit = {
  /** A site-relative path, including any query string. */
  path: string;
  /** Epoch ms. */
  at: number;
  /** Whether somebody was signed in at the time. */
  hasSession: boolean;
};

/**
 * Paths that must never be resumed into, whatever was recorded.
 *
 * The token-bearing ones are the important half: `/email-settings/<token>` is
 * an exchange that consumes its token and redirects, so returning to it later
 * lands on a URL that no longer works. The auth screens are the other half —
 * coming back to a half-finished sign-in, or to a password reset whose link has
 * since expired, is worse than starting from the home page.
 */
const NON_RESUMABLE_PREFIXES = [
  "/app",
  "/api/",
  "/lovable/",
  "/email-settings/",
  "/auth",
  "/reset-password",
  "/update-password",
];

/**
 * Whether a path is one the app may record and open on.
 *
 * Deliberately strict, and deliberately not relying on what the router happens
 * to do with a bad value. This string is read back off the device, so it is the
 * one input here that an attacker with any script foothold on the origin could
 * choose; today's router normalises its way out of most of it, but that is its
 * internals, not a guarantee this code owns.
 */
export function isResumablePath(path: string): boolean {
  // Site-relative only. A protocol-relative "//evil.example" is a URL a browser
  // treats as another origin. So is a backslash form in several parsers, which
  // is why a backslash anywhere is refused outright rather than reasoned about.
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  // Control characters and whitespace never appear in a path a real navigation
  // produced, and are the classic way to smuggle one parser past another.
  // Checked by code point rather than a regex literal, which would need a
  // `no-control-regex` suppression to say the same thing less clearly.
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return false;
  }

  const pathname = path.split(/[?#]/)[0];
  // Traversal, raw or encoded. A browser resolves ".." before `location.pathname`
  // is ever readable, so this can only come from a value somebody planted -- and
  // "/x/../email-settings/tok" must not slip past the prefix list below.
  const lowered = pathname.toLowerCase();
  if (lowered.includes("..") || lowered.includes("%2e") || lowered.includes("%2f")) return false;
  if (lowered.includes("%5c")) return false;

  // Case-insensitively: the blocklist is about which SCREEN this is, and a
  // server that resolves "/Auth" to the auth screen would otherwise be reachable
  // through a spelling the list does not recognise.
  return !NON_RESUMABLE_PREFIXES.some((prefix) =>
    prefix.endsWith("/")
      ? lowered.startsWith(prefix)
      : lowered === prefix || lowered.startsWith(`${prefix}/`),
  );
}

/**
 * Where a launch should actually go.
 *
 * Returns the recorded path when returning to it is right, and otherwise falls
 * back to `resolveLaunchScreen`. The `hasSession` comparison matters as much as
 * the clock: somebody who has signed out since must not be dropped back onto a
 * manager screen and bounced straight to the sign-in page, and somebody who has
 * since signed IN wants their member area, not the marketing page they were
 * reading beforehand.
 */
export function resolveLaunchTarget({
  hasSession,
  lastVisit,
  now,
}: LaunchState & { lastVisit: LastVisit | null; now: number }):
  | { path: string }
  | { screen: LaunchScreen } {
  if (
    lastVisit &&
    lastVisit.hasSession === hasSession &&
    now - lastVisit.at >= 0 &&
    now - lastVisit.at <= LAUNCH_RESUME_WINDOW_MS &&
    isResumablePath(lastVisit.path)
  ) {
    return { path: lastVisit.path };
  }
  return { screen: resolveLaunchScreen({ hasSession }) };
}
