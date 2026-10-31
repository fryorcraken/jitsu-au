// The 24-hour supply-chain guard in bunfig.toml skips any package version
// published less than a day ago, except for the names in
// `minimumReleaseAgeExcludes`. Each of those is a standing decision to install a
// release the moment it lands, so two things keep the list honest:
//
// - Every name on it is something an install actually brings in. An entry for
//   a package nothing installs protects nothing, and would quietly waive the
//   guard if the name ever came back. Two such entries sat here unnoticed
//   after vite-tanstack-config started bundling its plugins.
// - An exempt package this repo depends on directly is pinned exactly. A
//   caret range on an exempt package means a brand-new release, unguarded, is
//   what the next install picks up: package.json runs ahead of the lockfile
//   between Lovable re-resolves (CLAUDE.md, "Lock file strategy").
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

function exemptPackages(): string[] {
  const line = read("bunfig.toml")
    .split("\n")
    .find((l) => l.trim().startsWith("minimumReleaseAgeExcludes"));
  if (!line) throw new Error("bunfig.toml has no minimumReleaseAgeExcludes line");
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** True when bun.lock records a resolved version of `name`, at any depth. */
function isLocked(lock: string, name: string): boolean {
  return lock.includes(`["${name}@`);
}

describe("the release-age guard's exemptions", () => {
  const exempt = exemptPackages();

  it("lists something", () => {
    expect(exempt.length).toBeGreaterThan(0);
  });

  it("names only packages an install brings in", () => {
    const lock = read("bun.lock");
    expect(exempt.filter((name) => !isLocked(lock, name))).toEqual([]);
  });

  it("pins every exempt direct dependency exactly", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    const floating = exempt
      .filter((name) => name in declared)
      .filter((name) => !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(declared[name]))
      .map((name) => `${name}@${declared[name]}`);
    expect(floating).toEqual([]);
  });
});
