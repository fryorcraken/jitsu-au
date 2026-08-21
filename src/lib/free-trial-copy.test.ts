import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The club's free trial is two sessions, used at any point **during the
 * semester**. `/first-class` has always stated it that way; `/pricing` sold it
 * as year-round in three places ("all year long", "every day of the year",
 * "always free") and the footer repeated it site-wide ("all year round").
 * Advertising a free offer more broadly than the club honours it is exactly
 * what ACL s18 covers, so this is worth a guard rather than a one-off fix.
 *
 * There is no single string to import: each page states the offer in the voice
 * and the length that page needs, and the same sentence would read wrong in
 * all four places. What can be pinned is the claim that must not come back.
 *
 * The scan reaches the app's own source and nothing else, so it is a guard,
 * not proof. Copy that lives as **data** is invisible to it: a membership
 * plan's `description` is typed into `/manager/membership-plans` and rendered
 * on `/membership`, and the trial plan's seeded one still claims the offer
 * runs all year (`docs/memberships.md`).
 */
const YEAR_ROUND_CLAIMS = [
  /all year\b/i,
  /every day of the year/i,
  /year[- ]round\b/i,
  /always free/i,
  /free,? always/i,
  /any time of (the )?year/i,
];

const srcDir = join(import.meta.dirname, "..");

/** Every source file under `dir` that carries user-facing copy, walked recursively. */
function collectCopyFiles(dir: string): { path: string; source: string }[] {
  const found: { path: string; source: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Generated shadcn primitives carry no club copy.
      if (entry.name === "ui") continue;
      found.push(...collectCopyFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (entry.name === "routeTree.gen.ts") continue;
    found.push({ path, source: readFileSync(path, "utf8") });
  }
  return found;
}

describe("the free trial is never advertised as year-round", () => {
  const files = [
    ...collectCopyFiles(join(srcDir, "routes")),
    ...collectCopyFiles(join(srcDir, "components", "site")),
    ...collectCopyFiles(join(srcDir, "lib", "email-templates")),
    { path: "lib/faq.ts", source: readFileSync(join(srcDir, "lib", "faq.ts"), "utf8") },
    { path: "lib/seo.ts", source: readFileSync(join(srcDir, "lib", "seo.ts"), "utf8") },
  ];

  it("finds the copy files (guards against the scan itself breaking)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some(({ path }) => path.endsWith("pricing.tsx"))).toBe(true);
    expect(files.some(({ path }) => path.endsWith("SiteFooter.tsx"))).toBe(true);
  });

  it.each(YEAR_ROUND_CLAIMS.map((claim) => ({ claim })))("no page claims $claim", ({ claim }) => {
    const offenders = files.filter(({ source }) => claim.test(source)).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

describe("the pages that sell the trial say when it runs", () => {
  const pricing = readFileSync(join(srcDir, "routes", "pricing.tsx"), "utf8");
  const firstClass = readFileSync(join(srcDir, "routes", "first-class.tsx"), "utf8");

  // Shorter statements elsewhere ("first two sessions free") are fine: they
  // state the offer without claiming a window. These two pages are where
  // someone decides to come in or to pay, so they carry the qualifier.
  it("qualifies the offer on /pricing and /first-class", () => {
    expect(pricing).toMatch(/during the semester/i);
    expect(firstClass).toMatch(/during the semester/i);
  });
});
