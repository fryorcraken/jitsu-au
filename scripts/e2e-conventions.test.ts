// The two rules that keep the pull request gallery complete.
//
// Screenshots are a byproduct of the end-to-end suite (e2e/support/screenshots.ts),
// which means they only exist where a spec uses the suite's own `test` object
// and its `step`. A spec that reaches past them still passes — it just quietly
// stops appearing in what a reviewer looks at, which is the kind of gap nobody
// finds until they go looking for a screen that should have been there.
//
// So the rules are checked here, in the unit suite, rather than trusted:
//
//   1. a spec imports `test` from e2e/support/test, not from @playwright/test,
//   2. and calls `step(page, ...)` rather than the bare `test.step(...)`.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const E2E_DIR = resolve(process.cwd(), "e2e");

/** Every spec file, relative to `e2e/`. Vitest runs at the repo root. */
function specFiles(): string[] {
  return readdirSync(E2E_DIR, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".spec.ts"))
    .sort();
}

function read(file: string): string {
  return readFileSync(join(E2E_DIR, file), "utf8");
}

describe("the end-to-end specs", () => {
  it("has specs to check", () => {
    // A path change that made specFiles() return nothing would turn both rules
    // below into tests that pass by finding no work.
    expect(specFiles().length).toBeGreaterThan(5);
  });

  it("imports `test` from the suite's own module, so every test is photographed", () => {
    const offenders = specFiles().filter((file) =>
      /^import \{[^}]*\btest\b[^}]*\} from "@playwright\/test"/m.test(read(file)),
    );
    expect(
      offenders,
      "import { test } from the support module instead — see e2e/support/test.ts",
    ).toEqual([]);
  });

  it("uses the photographing `step`, so no step of a flow goes unseen", () => {
    const offenders = specFiles().filter((file) => read(file).includes("test.step("));
    expect(
      offenders,
      "use `step(page, title, body)` from e2e/support/screenshots.ts instead of test.step",
    ).toEqual([]);
  });
});
