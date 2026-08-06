import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NEUTRAL_STATUS_CLASS,
  blogCommentClass,
  blogPostClass,
  coverageClass,
  lifecycleClass,
  mediaConsentClass,
  membershipClass,
  verificationClass,
  waiverClass,
} from "./status-colours";
import {
  blogCommentStatuses,
  blogPostStatuses,
  coverageSources,
  lifecycleStatuses,
  membershipStatuses,
  waiverListStatuses,
} from "@/lib/validation";

describe("status colours", () => {
  it("gives every lifecycle phase a colour", () => {
    for (const status of lifecycleStatuses) {
      expect(lifecycleClass(status)).toMatch(/^bg-/);
    }
  });

  it("gives every membership state a colour", () => {
    for (const status of membershipStatuses) {
      expect(membershipClass(status)).toMatch(/^bg-/);
    }
  });

  it("gives each lifecycle phase a colour of its own", () => {
    // Two phases sharing a colour would make the directory unreadable at a
    // glance, which is the only thing the pills are for.
    const colours = new Set(lifecycleStatuses.map(lifecycleClass));
    expect(colours.size).toBe(lifecycleStatuses.length);
  });

  it("gives every coverage source a colour", () => {
    for (const source of coverageSources) {
      expect(coverageClass(source)).toMatch(/^bg-/);
    }
  });

  it("flags an uncovered check-in in red", () => {
    // The one state on the board a manager has to act on before the person
    // steps on the mat, so it is the one place red is right.
    expect(coverageClass("none")).toContain("red");
    for (const source of coverageSources.filter((s) => s !== "none")) {
      expect(coverageClass(source)).not.toContain("red");
    }
  });

  it("falls back to neutral for a status it does not know", () => {
    expect(lifecycleClass("banished")).toBe(NEUTRAL_STATUS_CLASS);
    expect(membershipClass("refunded")).toBe(NEUTRAL_STATUS_CLASS);
    expect(verificationClass("maybe")).toBe(NEUTRAL_STATUS_CLASS);
    expect(waiverClass("shredded")).toBe(NEUTRAL_STATUS_CLASS);
    expect(coverageClass("barter")).toBe(NEUTRAL_STATUS_CLASS);
  });

  it("badges an unverified address as a thing to notice, not a fault", () => {
    expect(verificationClass("verified")).toContain("green");
    expect(verificationClass("unverified")).toContain("amber");
    expect(verificationClass("unverified")).not.toContain("red");
  });

  it("keeps waiver statuses on the theme tokens both waiver screens use", () => {
    // The drift this module exists to stop: a pending waiver was grey on
    // /manager/waivers and amber on the person page, two screens a manager
    // moves between. Pin the vocabulary so the next copy cannot diverge.
    for (const status of waiverListStatuses) {
      expect(waiverClass(status)).not.toMatch(/amber|slate/);
    }
    expect(waiverClass("pending")).toBe("bg-muted text-muted-foreground");
    expect(waiverClass("active")).toBe("bg-primary/15 text-primary");
    expect(waiverClass("superseded")).toContain("line-through");
  });

  it("does not colour a pending membership and a pending waiver alike", () => {
    // They are different things in different vocabularies; the shared module
    // must not quietly collapse them because they share a word.
    expect(membershipClass("pending")).not.toBe(waiverClass("pending"));
  });

  it("gives every blog post status a colour", () => {
    for (const status of blogPostStatuses) {
      expect(blogPostClass(status)).toMatch(/^bg-/);
    }
  });

  it("gives every blog comment status a colour", () => {
    for (const status of blogCommentStatuses) {
      expect(blogCommentClass(status)).toMatch(/^bg-/);
    }
  });

  it("flags a hidden comment in red", () => {
    expect(blogCommentClass("hidden")).toContain("red");
    expect(blogCommentClass("visible")).not.toContain("red");
  });

  it("does not treat a draft post as a fault", () => {
    expect(blogPostClass("draft")).toBe(NEUTRAL_STATUS_CLASS);
  });

  it("badges media consent by its three real states", () => {
    // Green for yes, and it must never share a colour with either "no" or
    // "not asked" -- those two carry different meanings (a refusal to honour
    // versus a gap to close) and must not read the same either.
    expect(mediaConsentClass(true)).toContain("green");
    expect(mediaConsentClass(false)).toContain("red");
    expect(mediaConsentClass(null)).toContain("amber");
    const colours = new Set([
      mediaConsentClass(true),
      mediaConsentClass(false),
      mediaConsentClass(null),
    ]);
    expect(colours.size).toBe(3);
  });

  it("treats an unset media consent the same as an explicit not-asked", () => {
    // `undefined` shows up wherever the caller has an optional/missing field
    // rather than a column that is genuinely NULL; both mean "never asked".
    expect(mediaConsentClass(undefined)).toBe(mediaConsentClass(null));
  });

  it("does not read a withdrawn media consent as a mere gap", () => {
    // An explicit "no" must stop a manager the way an uncovered check-in does,
    // not blend into the same amber used for "nobody has asked yet".
    expect(mediaConsentClass(false)).not.toContain("amber");
  });
});

/**
 * The guard that actually stops #71 recurring.
 *
 * Every test above passes whether or not a single screen uses these modules,
 * which is how this PR shipped with the account page still hand-rolling its own
 * badge (a superseded waiver painted exactly like a pending one). The failure
 * mode is a route rolling its own copy, so that is what gets checked, by
 * reading the route files the way `seo.test.ts` does.
 */
describe("no screen rolls its own status pill", () => {
  const roots = ["src/routes", "src/components/site"];

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
      return [path];
    });
  }

  const files = roots.flatMap(walk);

  it("finds route files to check", () => {
    // A broken walk would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(20);
  });

  it("declares the badge in exactly one place", () => {
    const owners = files.filter((f) => /function Pill\(/.test(readFileSync(f, "utf8")));
    expect(owners).toEqual(["src/components/site/StatusPill.tsx"]);
  });

  it("keeps the status palette out of the screens", () => {
    // `bg-<hue>-100 text-<hue>-800` is unmistakably a status colour, so it
    // belongs in status-colours.ts. Other palette shades are left alone: a
    // marketing callout is entitled to its own colour.
    for (const file of files) {
      const offenders = readFileSync(file, "utf8").match(/bg-(\w+)-100 text-\1-800/g);
      expect(offenders, `${file} hardcodes a status colour`).toBeNull();
    }
  });
});
