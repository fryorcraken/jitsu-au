// Guards two of the copy rules in AGENTS.md across everything under src/.
//
// The scan itself, why it reads syntax rather than lines, and why only these
// two rules are mechanical, are documented at the top of scripts/copy-voice.ts.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EXEMPT_FILES,
  findBannedConstructions,
  findCopyViolations,
  findEmDashesInSource,
  isCopyScanned,
} from "./copy-voice";

const ROOT = resolve(process.cwd());

/** Every scanned source file, repo-relative and sorted. Vitest runs at the repo root. */
function scannedFiles(): string[] {
  return readdirSync(join(ROOT, "src"), { recursive: true })
    .map((entry) => `src/${String(entry).split("\\").join("/")}`)
    .filter(isCopyScanned)
    .sort();
}

describe("findEmDashesInSource", () => {
  it("flags an em dash in a string literal", () => {
    const found = findEmDashesInSource("x.ts", `const t = "Free trial — no gear needed";`);
    expect(found).toEqual([{ line: 1, rule: "em dash", snippet: "Free trial — no gear needed" }]);
  });

  it("flags an em dash in a template literal, including after a substitution", () => {
    const found = findEmDashesInSource("x.ts", "const t = `Upvote — ${n} upvotes`;");
    expect(found).toHaveLength(1);
  });

  it("flags an em dash in JSX text", () => {
    const found = findEmDashesInSource("x.tsx", `const el = <p>Draft — not signed</p>;`);
    expect(found).toHaveLength(1);
  });

  it("allows an em dash in a comment, which is internal writing", () => {
    const source = [
      "// honeypot — must stay empty",
      "/* also fine — a block comment */",
      "const el = <p>{/* and a JSX one — fine too */}</p>;",
    ].join("\n");
    expect(findEmDashesInSource("x.tsx", source)).toEqual([]);
  });

  it("allows the placeholder glyph for an empty value", () => {
    const source = [
      `export const EMPTY = "—";`,
      `const el = <td>{value || "—"}</td>;`,
      `const also = <span>—</span>;`,
    ].join("\n");
    expect(findEmDashesInSource("x.tsx", source)).toEqual([]);
  });

  it("allows an en dash in a numeric range", () => {
    expect(findEmDashesInSource("x.ts", `const t = "5:30 – 7:00pm";`)).toEqual([]);
  });

  it("allows a console log, which is not copy", () => {
    const source = `console.warn("[email] LOVABLE_API_KEY not set — skipping emails");`;
    expect(findEmDashesInSource("x.ts", source)).toEqual([]);
  });

  it("reports the line the dash is on", () => {
    const source = ["const a = 1;", "", `const t = "Two sentences — one dash";`].join("\n");
    expect(findEmDashesInSource("x.ts", source)[0].line).toBe(3);
  });
});

describe("findBannedConstructions", () => {
  it('flags "whether you\'re X or Y"', () => {
    const source = `const t = "Our classes suit everyone, whether you're new or experienced.";`;
    expect(findBannedConstructions("x.ts", source)).toHaveLength(1);
  });

  it("flags it across a line wrap in JSX", () => {
    const source = [
      "const el = (",
      "  <p>",
      "    Come along, whether",
      "    you are new or not.",
      "  </p>",
      ");",
    ].join("\n");
    expect(findBannedConstructions("x.tsx", source)).toHaveLength(1);
  });

  it(`flags "it's not just X, it's Y"`, () => {
    const source = `const t = "It's not just a workout, it's a skill you keep.";`;
    expect(findBannedConstructions("x.ts", source)).toHaveLength(1);
  });

  it("leaves ordinary sentences alone", () => {
    const source = [
      `const a = "Everyone trains together, whatever they have done before.";`,
      `const b = "Bring a water bottle. You do not need a Gi for your first class.";`,
      `const c = "Filling this in is what unlocks the student rate for them.";`,
    ].join("\n");
    expect(findBannedConstructions("x.ts", source)).toEqual([]);
  });
});

describe("isCopyScanned", () => {
  it("skips generated files and tests, which quote copy in order to pin it", () => {
    expect(isCopyScanned("src/routes/routeTree.gen.ts")).toBe(false);
    expect(isCopyScanned("src/integrations/supabase/types.ts")).toBe(false);
    expect(isCopyScanned("src/lib/faq.test.ts")).toBe(false);
    expect(isCopyScanned("src/components/site/WaiverDocument.test.tsx")).toBe(false);
    expect(isCopyScanned("src/styles.css")).toBe(false);
  });

  it("scans ordinary source", () => {
    expect(isCopyScanned("src/lib/faq.ts")).toBe(true);
    expect(isCopyScanned("src/routes/about.tsx")).toBe(true);
  });

  it("skips the agent-facing files, and only those", () => {
    for (const file of EXEMPT_FILES) expect(isCopyScanned(file)).toBe(false);
    expect(EXEMPT_FILES).toHaveLength(2);
  });
});

describe("the copy under src/", () => {
  const files = scannedFiles();

  it("gives the scan something to read", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("breaks neither rule", () => {
    const offences: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const v of findCopyViolations(file, source)) {
        offences.push(`${file}:${v.line}  [${v.rule}]  ${v.snippet}`);
      }
    }
    // An em dash: split into two sentences, or use a comma, colon, parentheses,
    // or "and"/"but". A banned construction: say the specific thing instead.
    // Both rules, and their exceptions, are in AGENTS.md under "Writing style
    // for website copy".
    expect(offences).toEqual([]);
  });
});
