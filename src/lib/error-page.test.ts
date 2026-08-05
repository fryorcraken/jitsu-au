import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { renderErrorPage } from "./error-page";

/**
 * `data-page-state` is the contract between the app's failure boundaries and
 * `scripts/pr-screenshots.mjs`, which fails a screenshot run when it finds one.
 *
 * It has to be an attribute rather than the visible copy: the copy is website
 * prose and may be rewritten at any time, and both boundaries render inside an
 * ordinary 200 response, so nothing else distinguishes a broken page from a
 * page that rendered. Losing the marker would make the screenshot job pass on
 * a site that is showing "This page didn't load" on every route — which is
 * exactly what it was built to catch.
 */
describe("failure-boundary markers", () => {
  it("marks the server-rendered error page", () => {
    expect(renderErrorPage()).toContain('data-page-state="error"');
  });

  it("marks the router's error and not-found boundaries", () => {
    const root = readFileSync(resolve(__dirname, "../routes/__root.tsx"), "utf8");

    expect(root).toContain('data-page-state="error"');
    expect(root).toContain('data-page-state="not-found"');
  });

  // Every route defers to the root boundaries today. One that declares its own
  // would render unmarked, and the screenshot run would call a broken page a
  // clean one — the exact false pass the marker exists to prevent.
  it("has no route declaring an unmarked boundary of its own", () => {
    const offenders = routeFiles(resolve(__dirname, "../routes")).filter((file) => {
      const source = readFileSync(file, "utf8");
      const declaresBoundary = /^\s*(errorComponent|notFoundComponent):/m.test(source);
      return declaresBoundary && !source.includes("data-page-state");
    });

    expect(offenders).toEqual([]);
  });
});

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [full];
  });
}
