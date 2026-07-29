import { describe, it, expect } from "vitest";
import {
  coveragePreviewLabel,
  lapsedMembershipIds,
  pickDefaultEvent,
  resolveCoverage,
} from "./checkin";
import type { CoverageCandidate } from "./checkin";

/** The class being checked in to, and the instant coverage is resolved at. */
const AT = "2026-08-05T08:00:00.000Z";

function membership(over: Partial<CoverageCandidate> = {}): CoverageCandidate {
  return {
    id: "m1",
    kind: "session",
    plan_name: "Casual class",
    status: "active",
    price_cents: 3000,
    sessions_remaining: 1,
    starts_at: "2026-08-01T00:00:00.000Z",
    ends_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

const trial = (over: Partial<CoverageCandidate> = {}) =>
  membership({
    id: "trial",
    kind: "trial",
    plan_name: "Free trial",
    price_cents: 0,
    sessions_remaining: 2,
    ...over,
  });

const semester = (over: Partial<CoverageCandidate> = {}) =>
  membership({
    id: "semester",
    kind: "period",
    plan_name: "One semester",
    price_cents: 44500,
    sessions_remaining: null,
    ends_at: "2026-12-14T00:00:00.000Z",
    ...over,
  });

describe("resolveCoverage", () => {
  it("spends the free trial before an unlimited membership", () => {
    const d = resolveCoverage({ memberships: [semester(), trial()], at: AT });
    expect(d.coverage).toBe("trial");
    expect(d.membership_id).toBe("trial");
    expect(d.consumes_credit).toBe(true);
    expect(d.sessions_remaining_before).toBe(2);
    expect(d.sessions_remaining_after).toBe(1);
    expect(d.closes_membership).toBe(false);
  });

  it("spends a casual credit before an unlimited membership", () => {
    const d = resolveCoverage({ memberships: [semester(), membership()], at: AT });
    expect(d.coverage).toBe("session");
    expect(d.membership_id).toBe("m1");
    expect(d.consumes_credit).toBe(true);
  });

  it("spends the trial before a casual credit", () => {
    const d = resolveCoverage({ memberships: [membership(), trial()], at: AT });
    expect(d.coverage).toBe("trial");
  });

  it("covers with an unlimited membership when there are no credits, spending nothing", () => {
    const d = resolveCoverage({ memberships: [semester()], at: AT });
    expect(d.coverage).toBe("period");
    expect(d.membership_id).toBe("semester");
    expect(d.consumes_credit).toBe(false);
    expect(d.sessions_remaining_after).toBeNull();
    expect(d.closes_membership).toBe(false);
  });

  it("never covers a class with yearly insurance alone", () => {
    const insurance = membership({
      id: "ins",
      kind: "insurance",
      plan_name: "Sydney Jitsu yearly membership",
      sessions_remaining: null,
      ends_at: "2027-01-01T00:00:00.000Z",
    });
    const d = resolveCoverage({ memberships: [insurance], at: AT });
    expect(d.coverage).toBe("none");
    expect(d.warnings).toContain("no_cover");
  });

  it("returns no cover, with a reason, when there is nothing at all", () => {
    const d = resolveCoverage({ memberships: [], at: AT });
    expect(d.coverage).toBe("none");
    expect(d.membership_id).toBeNull();
    expect(d.consumes_credit).toBe(false);
    expect(d.warnings).toEqual(["no_cover"]);
  });

  // There is no expiry job in this app, so an ended membership still reads
  // `status = 'active'`. Trusting the status alone would cover classes for
  // months after the money ran out.
  it("does not cover with a membership past its end date, and says so", () => {
    const ended = semester({ ends_at: "2026-06-30T00:00:00.000Z" });
    const d = resolveCoverage({ memberships: [ended], at: AT });
    expect(d.coverage).toBe("none");
    expect(d.warnings).toContain("membership_ended");
    expect(d.warnings).toContain("no_cover");
  });

  it("does not cover with a credit membership that has none left, and says so", () => {
    const d = resolveCoverage({ memberships: [trial({ sessions_remaining: 0 })], at: AT });
    expect(d.coverage).toBe("none");
    expect(d.warnings).toContain("credits_exhausted");
  });

  it("does not cover with a membership that has not started yet", () => {
    const future = membership({ starts_at: "2026-09-01T00:00:00.000Z" });
    expect(resolveCoverage({ memberships: [future], at: AT }).coverage).toBe("none");
  });

  it.each(["pending", "expired", "cancelled"])("does not cover with a %s membership", (status) => {
    expect(resolveCoverage({ memberships: [trial({ status })], at: AT }).coverage).toBe("none");
  });

  it("flags a paid membership still waiting on payment", () => {
    const d = resolveCoverage({ memberships: [semester({ status: "pending" })], at: AT });
    expect(d.warnings).toContain("payment_pending");
  });

  it("closes the membership when the last credit goes", () => {
    const d = resolveCoverage({ memberships: [trial({ sessions_remaining: 1 })], at: AT });
    expect(d.sessions_remaining_after).toBe(0);
    expect(d.closes_membership).toBe(true);
    expect(d.warnings).toContain("last_credit");
  });

  it("takes from the membership that runs out soonest", () => {
    const few = membership({ id: "few", sessions_remaining: 1 });
    const many = membership({ id: "many", sessions_remaining: 5 });
    expect(resolveCoverage({ memberships: [many, few], at: AT }).membership_id).toBe("few");
  });

  it("breaks an equal balance on the earlier end date, then the older row", () => {
    const later = membership({ id: "later", ends_at: "2026-12-01T00:00:00.000Z" });
    const sooner = membership({ id: "sooner", ends_at: "2026-09-01T00:00:00.000Z" });
    expect(resolveCoverage({ memberships: [later, sooner], at: AT }).membership_id).toBe("sooner");

    const newer = membership({ id: "newer", created_at: "2026-08-02T00:00:00.000Z" });
    const older = membership({ id: "older", created_at: "2026-07-01T00:00:00.000Z" });
    expect(resolveCoverage({ memberships: [newer, older], at: AT }).membership_id).toBe("older");
  });

  it("reaches the same answer whatever order the memberships arrive in", () => {
    const set = [semester(), trial({ sessions_remaining: 2 }), membership()];
    const forwards = resolveCoverage({ memberships: set, at: AT });
    const backwards = resolveCoverage({ memberships: [...set].reverse(), at: AT });
    expect(backwards).toEqual(forwards);
  });

  // sessions_remaining_before is the compare-and-set guard the server writes
  // with: a wrong value silently disables the double-spend protection.
  it("reports the chosen membership's balance as it stands", () => {
    const d = resolveCoverage({ memberships: [trial({ sessions_remaining: 2 })], at: AT });
    expect(d.sessions_remaining_before).toBe(2);
  });

  // Resolution is keyed off the class, not the clock, so a late check-in and a
  // punctual one agree.
  it("covers a class that the membership was live for, even if it has since ended", () => {
    const ended = semester({ ends_at: "2026-08-05T12:00:00.000Z" });
    expect(resolveCoverage({ memberships: [ended], at: AT }).coverage).toBe("period");
    expect(resolveCoverage({ memberships: [ended], at: "2026-09-01T08:00:00.000Z" }).coverage).toBe(
      "none",
    );
  });
});

describe("coveragePreviewLabel", () => {
  it("names the plan and what is left of it", () => {
    const d = resolveCoverage({ memberships: [trial()], at: AT });
    expect(coveragePreviewLabel(d)).toBe("Free trial, 2 left");
  });

  it("names an unlimited plan without a count", () => {
    const d = resolveCoverage({ memberships: [semester()], at: AT });
    expect(coveragePreviewLabel(d)).toBe("One semester");
  });

  it("says so plainly when nothing covers it", () => {
    expect(coveragePreviewLabel(resolveCoverage({ memberships: [], at: AT }))).toBe("No cover");
  });
});

describe("lapsedMembershipIds", () => {
  const NOW = "2026-08-05T09:00:00.000Z";

  it("finds active memberships whose end date has passed", () => {
    const ended = semester({ id: "ended", ends_at: "2026-06-30T00:00:00.000Z" });
    expect(lapsedMembershipIds([ended, semester(), trial()], NOW)).toEqual(["ended"]);
  });

  it("leaves open-ended and already-closed memberships alone", () => {
    const closed = semester({ id: "closed", status: "expired", ends_at: "2026-01-01T00:00:00Z" });
    expect(lapsedMembershipIds([closed, trial()], NOW)).toEqual([]);
  });
});

describe("pickDefaultEvent", () => {
  const event = (id: string, starts_at: string, status = "scheduled") => ({
    id,
    starts_at,
    status,
  });

  it("returns null when there is nothing to pick", () => {
    expect(pickDefaultEvent([], "2026-08-05T08:00:00.000Z")).toBeNull();
  });

  it("picks the only class on today", () => {
    // 18:00 Sydney on 5 Aug (AEST, UTC+10) is 08:00 UTC.
    const today = event("today", "2026-08-05T08:00:00.000Z");
    const nextWeek = event("next", "2026-08-12T08:00:00.000Z");
    expect(pickDefaultEvent([nextWeek, today], "2026-08-05T02:00:00.000Z")?.id).toBe("today");
  });

  it("picks the closest of several classes today, including one that just finished", () => {
    const morning = event("morning", "2026-08-04T23:00:00.000Z"); // 09:00 Sydney
    const evening = event("evening", "2026-08-05T08:00:00.000Z"); // 18:00 Sydney
    // 09:20 Sydney: the morning class started twenty minutes ago.
    const at = "2026-08-04T23:20:00.000Z";
    expect(pickDefaultEvent([evening, morning], at)?.id).toBe("morning");
  });

  it("breaks an exact tie on today toward the earlier class", () => {
    const first = event("first", "2026-08-04T23:00:00.000Z");
    const second = event("second", "2026-08-05T01:00:00.000Z");
    // Exactly midway between the two.
    expect(pickDefaultEvent([second, first], "2026-08-05T00:00:00.000Z")?.id).toBe("first");
  });

  it("falls back to the nearest class when none is on today", () => {
    const yesterday = event("yesterday", "2026-08-04T08:00:00.000Z");
    const tomorrow = event("tomorrow", "2026-08-06T08:00:00.000Z");
    // 14:00 Sydney on the 5th: closer to yesterday evening than tomorrow's.
    expect(pickDefaultEvent([tomorrow, yesterday], "2026-08-05T04:00:00.000Z")?.id).toBe(
      "yesterday",
    );
  });

  it("breaks an exact tie off today toward the future", () => {
    const past = event("past", "2026-08-03T00:00:00.000Z");
    const future = event("future", "2026-08-07T00:00:00.000Z");
    expect(pickDefaultEvent([past, future], "2026-08-05T00:00:00.000Z")?.id).toBe("future");
  });

  it("never picks a cancelled class, even when it is the closest", () => {
    const cancelled = event("cancelled", "2026-08-05T08:00:00.000Z", "cancelled");
    const other = event("other", "2026-08-06T08:00:00.000Z");
    expect(pickDefaultEvent([cancelled, other], "2026-08-05T07:55:00.000Z")?.id).toBe("other");
    expect(pickDefaultEvent([cancelled], "2026-08-05T07:55:00.000Z")).toBeNull();
  });

  // The case a UTC-date implementation gets wrong: at 09:00 Sydney the UTC date
  // is still the previous day, so "today" has to be resolved in club time.
  it("treats a morning class as today at the club, not yesterday in UTC", () => {
    const morning = event("morning", "2026-08-04T23:00:00.000Z"); // 09:00 Sydney, 5 Aug
    const nextWeek = event("next", "2026-08-11T23:00:00.000Z");
    // 08:00 Sydney on 5 Aug == 22:00 UTC on 4 Aug.
    expect(pickDefaultEvent([nextWeek, morning], "2026-08-04T22:00:00.000Z")?.id).toBe("morning");
  });

  // Sydney leaves daylight saving on 2026-04-05, so the club-local date has to
  // be computed at the instant, not with a fixed offset.
  it("resolves the club date correctly across a daylight-saving change", () => {
    const dstDay = event("dst", "2026-04-04T22:00:00.000Z"); // 09:00 AEDT on 5 Apr
    expect(pickDefaultEvent([dstDay], "2026-04-04T21:00:00.000Z")?.id).toBe("dst");
  });
});
