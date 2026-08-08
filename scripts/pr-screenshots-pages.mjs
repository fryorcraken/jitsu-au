// Which pages the screenshot run photographs, and who it has to be signed in
// as to see them.
//
// Split out of the entrypoint for the same reason as pr-screenshots-report.mjs:
// that script deletes a directory and spawns a server at import time, so this
// logic is only testable on its own.
//
// The signed-in pages are DERIVED FROM THE ROUTE FILES rather than listed here.
// A new manager screen is one new file, and it should be photographed the
// moment it exists — the same bargain src/lib/seo.ts strikes for the public
// pages, where the sitemap test refuses to let a page go unlisted.

/**
 * Route directories whose pages need a session. Everything under
 * `_authenticated/` is gated by that group's `beforeLoad`; `kb/` gates itself
 * the same way in its own layout route (src/routes/kb/route.tsx).
 */
export const SIGNED_IN_ROUTE_DIRS = ["_authenticated", "kb"];

/**
 * Turn a route file path (relative to `src/routes`) into the URL it serves,
 * or null when the file is not a page.
 *
 * TanStack Start's file conventions, as used in this repo (src/routes/README.md):
 *   `manager.waivers.tsx`        -> /manager/waivers   (dots are separators)
 *   `manager.index.tsx`          -> /manager           (index names its parent)
 *   `_authenticated/account.tsx` -> /account           (`_name` is pathless)
 *   `manager.users_.$userId.tsx` -> /manager/users/$userId  (trailing _ escapes
 *                                                            layout nesting only)
 *   `route.tsx`                  -> null               (a layout, not a page)
 */
export function routeFileToPath(file) {
  if (!file.endsWith(".tsx")) return null;
  if (file.includes(".test.")) return null;

  const segments = file
    .slice(0, -".tsx".length)
    .split("/")
    .flatMap((part) => part.split("."))
    .map((segment) => segment.replace(/_$/, ""))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return null;
  if (segments.at(-1) === "route") return null;

  const path = segments.filter((segment) => !segment.startsWith("_"));
  if (path.at(-1) === "index") path.pop();
  return `/${path.join("/")}`;
}

/** Every signed-in page, from a list of route files relative to `src/routes`. */
export function signedInPaths(files) {
  const paths = files
    .filter((file) => SIGNED_IN_ROUTE_DIRS.some((dir) => file.startsWith(`${dir}/`)))
    .map(routeFileToPath)
    .filter((path) => path !== null);
  return [...new Set(paths)].sort();
}

/**
 * Who has to be signed in for a page to render.
 *
 * Manager screens redirect a member away client-side (see manager.waivers.tsx),
 * so photographing them as a member would capture the redirect, not the screen.
 * Everything else in the member area is visible to any signed-in person, and is
 * shot as the member because that is who reads it.
 */
export function personaFor(path) {
  return path === "/manager" || path.startsWith("/manager/") ? "manager" : "member";
}

/**
 * Substitute `$param` segments from `params`, keyed by the parameter's own
 * name (`$userId` -> `params.userId`).
 *
 * Returns null when the fixture has no value for one of them, which is the
 * signal to skip the page rather than photograph a 404. Route parameter names
 * are distinct across this repo's dynamic pages ($userId, $id, $slug), so one
 * flat map is enough; a future collision shows up as the wrong record on
 * screen, not a silent pass.
 */
export function fillRouteParams(path, params) {
  const filled = [];
  for (const segment of path.split("/")) {
    if (!segment.startsWith("$")) {
      filled.push(segment);
      continue;
    }
    const value = params?.[segment.slice(1)];
    if (!value) return null;
    filled.push(String(value));
  }
  return filled.join("/");
}
