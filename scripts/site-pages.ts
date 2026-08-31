// Which pages the site tour walks, and who it has to be signed in as to see
// them.
//
// The tour (e2e/tour/site.spec.ts) opens every page this branch serves,
// asserts it rendered, and photographs it. That list is DERIVED FROM THE ROUTE
// FILES rather than written down: a new manager screen is one new file, and it
// should be walked the moment it exists — the same bargain src/lib/seo.ts
// strikes for the public pages, where the sitemap test refuses to let a page go
// unlisted.
//
// Kept in `scripts/` rather than in `e2e/` because it is plain logic with no
// browser in it, so the unit suite tests it directly (scripts/site-pages.test.ts)
// instead of proving it through a Playwright run.

import { PUBLIC_PAGES, PUBLIC_NOINDEX_PATHS } from "../src/lib/public-pages";

export type Persona = "member" | "manager";

/** Every page a signed-out visitor can open, sitemap first. */
export function publicPaths(): string[] {
  return [...PUBLIC_PAGES.map((page) => page.path), ...PUBLIC_NOINDEX_PATHS];
}

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
export function routeFileToPath(file: string): string | null {
  if (!file.endsWith(".tsx")) return null;
  if (file.includes(".test.")) return null;

  const segments = file
    .slice(0, -".tsx".length)
    // `[.]` escapes a dot that is part of the URL rather than a separator
    // (robots[.]txt). Hold it as a placeholder across the split on dots.
    .replaceAll("[.]", " ")
    .split("/")
    .flatMap((part) => part.split("."))
    .map((segment) => segment.replaceAll(" ", ".").replace(/_$/, ""))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return null;
  if (segments.at(-1) === "route") return null;

  const path = segments.filter((segment) => !segment.startsWith("_"));
  // Every segment was pathless, so this file is a layout (`_layout.tsx`), not a
  // page. Returning "/" here would be worse than useless: it collides with the
  // home page, and the gallery would have the member-area render overwrite the
  // home page's picture — one image behind two rows of the contact sheet.
  if (path.length === 0) return null;
  if (path.at(-1) === "index") path.pop();
  if (path.length === 0) return null;
  return `/${path.join("/")}`;
}

/** Every signed-in page, from a list of route files relative to `src/routes`. */
export function signedInPaths(files: string[]): string[] {
  const paths = files
    .filter((file) => SIGNED_IN_ROUTE_DIRS.some((dir) => file.startsWith(`${dir}/`)))
    .map(routeFileToPath)
    .filter((path): path is string => path !== null);
  return [...new Set(paths)].sort();
}

/**
 * Who has to be signed in for a page to render.
 *
 * Manager screens redirect a member away client-side (see manager.waivers.tsx),
 * so walking them as a member would photograph the redirect, not the screen.
 * Everything else in the member area is visible to any signed-in person, and is
 * walked as the member because that is who reads it.
 */
export function personaFor(path: string): Persona {
  return path === "/manager" || path.startsWith("/manager/") ? "manager" : "member";
}

/**
 * Substitute parameter segments from `params`, keyed by the parameter's own
 * name (`$userId` -> `params.userId`, and the optional form `{-$category}`
 * likewise).
 *
 * Returns null when the fixture has no value for one, which the caller turns
 * into a hard failure rather than a 404 in the gallery.
 *
 * The flat map was enough only while the pages walked here happened not to
 * reuse a parameter name, and that stopped being true the moment `/account`
 * grew a per-person page: `$userId` names somebody a MANAGER is looking at on
 * `/manager/users/$userId`, and one of the MEMBER's own dependants on
 * `/account/$userId`. Two different people, one parameter name. So `byPath`
 * wins over the flat map for exactly the paths that need it, which is the fix
 * this comment used to predict rather than a new mechanism. The flat map still
 * answers everything else, because most parameters do mean one thing.
 */
export function fillRouteParams(
  path: string,
  params: Record<string, string> | undefined,
  byPath?: Record<string, Record<string, string>> | undefined,
): string | null {
  const overrides = byPath?.[path];
  const filled: string[] = [];
  for (const segment of path.split("/")) {
    const parameter = segment.match(/\$(\w+)/);
    if (!parameter) {
      filled.push(segment);
      continue;
    }
    const value = overrides?.[parameter[1]] ?? params?.[parameter[1]];
    if (!value) return null;
    filled.push(String(value));
  }
  return filled.join("/");
}

/**
 * Split the signed-in pages into one list per persona, with every route
 * parameter filled in.
 *
 * Throws rather than shrinking: with a seeded club in hand, a persona that
 * resolves to nothing or a parameter the fixture cannot fill mean this stopped
 * working, not that the screens went away.
 */
export function signedInPathsByPersona(
  routeFiles: string[],
  params: Record<string, string> | undefined,
  paramsByPath?: Record<string, Record<string, string>> | undefined,
): Record<Persona, string[]> {
  const byPersona: Record<Persona, string[]> = { member: [], manager: [] };
  const unfilled: string[] = [];

  for (const template of signedInPaths(routeFiles)) {
    const path = fillRouteParams(template, params, paramsByPath);
    if (!path) {
      unfilled.push(template);
      continue;
    }
    byPersona[personaFor(path)].push(path);
  }

  if (unfilled.length > 0) {
    throw new Error(
      `no fixture value for ${unfilled.join(", ")} — add the id to the manifest in seed-local-club.mjs`,
    );
  }
  for (const persona of ["member", "manager"] as const) {
    if (byPersona[persona].length === 0) {
      throw new Error(`no ${persona} pages found under src/routes — check signedInPaths`);
    }
  }
  return byPersona;
}
