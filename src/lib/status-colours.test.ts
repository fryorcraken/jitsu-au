import { describe, expect, it } from "vitest";
import {
  NEUTRAL_STATUS_CLASS,
  lifecycleClass,
  membershipClass,
  verificationClass,
  waiverClass,
} from "./status-colours";
import { lifecycleStatuses, membershipStatuses, waiverListStatuses } from "@/lib/validation";

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

  it("falls back to neutral for a status it does not know", () => {
    expect(lifecycleClass("banished")).toBe(NEUTRAL_STATUS_CLASS);
    expect(membershipClass("refunded")).toBe(NEUTRAL_STATUS_CLASS);
    expect(verificationClass("maybe")).toBe(NEUTRAL_STATUS_CLASS);
    expect(waiverClass("shredded")).toBe(NEUTRAL_STATUS_CLASS);
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
});
