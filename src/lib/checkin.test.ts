import { describe, it, expect } from "vitest";
import {
  attachableMemberships,
  coveragePreviewLabel,
  lapsedMembershipIds,
  pickDefaultEvent,
  resolveCoverage,
} from "./checkin";
import type { CoverageCandidate } from "./checkin";
import { planMembershipWindow } from "./validation";

/** The class being checked in to, and the instant coverage is resolved at. */
const AT = "2026-08-05T08:00:00.000Z";

function membership(over: Partial<CoverageCandidate> = {}): CoverageCandidate {
  return {
    id: "m1",
    kind: "session",
    plan_name: "Casual class",
    status: "active",
    price_cents: 3000,
    // Paid by default: most cases here are about coverage, not money, and an
    // unpaid default would add a payment warning to every one of them.
    paid_at: "2026-08-01T00:00:00.000Z",
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

  it("does not cover with a DATED membership that has not started yet, and says so", () => {
    const future = semester({
      starts_at: "2026-09-01T00:00:00.000Z",
      ends_at: "2026-12-14T00:00:00.000Z",
    });
    const d = resolveCoverage({ memberships: [future], at: AT });
    expect(d.coverage).toBe("none");
    expect(d.warnings).toContain("not_started");
  });

  // Someone having trained is a fact that already happened; paperwork catching up
  // afterwards cannot unmake it. A waiver signed at the door after the class
  // started, or filed from paper days later, still has to be payable by the
  // credits it earned -- so a credit balance is gated by its balance and by
  // nothing else. Exercises the real activation dates rather than hand-picked
  // ISO strings.
  it.each([
    ["signed at the door, after the class began", "2026-08-05T08:05:00.000Z"],
    ["approved days after the class", "2026-08-09T02:00:00.000Z"],
  ])("covers a class the credits were earned at, %s", (_label, grantedAt) => {
    const window = planMembershipWindow(
      { starts_on: null, ends_on: null, duration_days: null },
      grantedAt,
    );
    const d = resolveCoverage({ memberships: [trial({ ...window })], at: AT });
    expect(d.coverage).toBe("trial");
    expect(d.sessions_remaining_after).toBe(1);
    expect(d.warnings).not.toContain("not_started");
  });

  // Pre-buying the next training period is normal (`sellablePlans` offers a plan
  // before its start date), so holding a membership that begins later is not by
  // itself worth saying. Warned about beside a green pill it is noise, and it
  // would be frozen into `session_checkins.warnings` for good.
  it("does not warn about a later membership when something already covers the class", () => {
    const nextPeriod = semester({
      id: "next",
      starts_at: "2026-09-01T00:00:00.000Z",
      ends_at: "2026-12-14T00:00:00.000Z",
    });
    const d = resolveCoverage({ memberships: [nextPeriod, trial()], at: AT });
    expect(d.coverage).toBe("trial");
    expect(d.warnings).not.toContain("not_started");
  });

  // The balance rule is keyed off credits, not `kind`. A plan with neither dates
  // nor credits (the malformed shape docs/memberships.md warns about) has no
  // entitlement to spend, so it must not turn into an everything-covers pass.
  it("does not let an undated, credit-less membership cover an earlier class", () => {
    const malformed = semester({
      starts_at: "2026-09-01T00:00:00.000Z",
      ends_at: null,
      sessions_remaining: null,
    });
    expect(resolveCoverage({ memberships: [malformed], at: AT }).coverage).toBe("none");
  });

  // An unlimited plan is never a balance, however many credits are hung off it:
  // the period tier spends nothing, so treating an undated one as a balance
  // would hand out free unlimited cover of every class ever held, unwarned. The
  // database permits this shape -- savePlanSchema and the manager agent API do
  // not run planShapeError -- so only this guard stops it.
  it("does not let an undated period plan carrying credits cover an earlier class", () => {
    const unlimitedWithCredits = semester({
      starts_at: "2026-09-01T00:00:00.000Z",
      ends_at: null,
      sessions_remaining: 5,
    });
    const d = resolveCoverage({ memberships: [unlimitedWithCredits], at: AT });
    expect(d.coverage).toBe("none");
    expect(d.warnings).toContain("not_started");
  });

  // Exercises the actual dates activateMembershipRow writes for a dated plan
  // (planMembershipWindow), not hand-picked ISO strings -- a fencepost error
  // in that window (e.g. ending at UTC midnight instead of 23:59:59 Sydney)
  // would cut off the last day's evening class, and this is what would catch
  // it.
  it("covers a semester's final evening class and not the day before it starts", () => {
    const window = planMembershipWindow(
      { starts_on: "2026-07-20", ends_on: "2026-11-22", duration_days: null },
      "2026-01-01T00:00:00.000Z",
    );
    const semesterMembership = semester({ starts_at: window.starts_at, ends_at: window.ends_at });

    const lastEveningClass = "2026-11-22T09:00:00.000Z"; // 20:00 AEDT on the last day
    expect(
      resolveCoverage({ memberships: [semesterMembership], at: lastEveningClass }).coverage,
    ).toBe("period");

    const dayBeforeItStarts = "2026-07-19T08:00:00.000Z"; // 18:00 AEST the evening before
    expect(
      resolveCoverage({ memberships: [semesterMembership], at: dayBeforeItStarts }).coverage,
    ).toBe("none");
  });

  it.each(["pending", "expired", "cancelled"])("does not cover with a %s membership", (status) => {
    expect(resolveCoverage({ memberships: [trial({ status })], at: AT }).coverage).toBe("none");
  });

  // The member trains while the transfer clears, which is the whole point of
  // authorising and paying being separate — so the warning is keyed on the
  // payment, not the status. An unpaid member is `active` like everyone else,
  // and a status check would warn about nobody at all.
  it("flags a membership that is authorised but not paid for", () => {
    const d = resolveCoverage({ memberships: [semester({ paid_at: null })], at: AT });
    expect(d.coverage).toBe("period");
    expect(d.warnings).toContain("payment_pending");
  });

  it("says nothing about payment once one is recorded", () => {
    const d = resolveCoverage({ memberships: [semester()], at: AT });
    expect(d.warnings).not.toContain("payment_pending");
  });

  // A withdrawn invoice is owed nothing, so nobody should be chased for it.
  it("says nothing about payment on a cancelled membership", () => {
    const d = resolveCoverage({
      memberships: [semester({ status: "cancelled", paid_at: null })],
      at: AT,
    });
    expect(d.warnings).not.toContain("payment_pending");
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

// The manager's override on the attach flow: "use THIS membership", not
// whatever the precedence would have picked.
describe("resolveCoverage with an override", () => {
  it("uses the named membership even when precedence would pick another", () => {
    const d = resolveCoverage({
      memberships: [trial(), membership()],
      at: AT,
      only: "m1",
    });
    expect(d.membership_id).toBe("m1");
    expect(d.coverage).toBe("session");
  });

  it("covers nothing when the named membership cannot pay", () => {
    const d = resolveCoverage({
      memberships: [trial(), membership({ status: "expired" })],
      at: AT,
      only: "m1",
    });
    expect(d.coverage).toBe("none");
    expect(d.membership_id).toBeNull();
  });

  // The override picks what pays; it must not hide what else is wrong with the
  // account, or a manager fixes one thing and never sees the next.
  it("still reports warnings from the memberships it did not consider", () => {
    const d = resolveCoverage({
      memberships: [trial(), semester({ paid_at: null })],
      at: AT,
      only: "trial",
    });
    expect(d.coverage).toBe("trial");
    expect(d.warnings).toContain("payment_pending");
  });
});

describe("attachableMemberships", () => {
  it("marks what could pay, and says why the rest cannot", () => {
    const rows = attachableMemberships(
      [
        trial(),
        membership({ id: "spent", sessions_remaining: 0 }),
        semester({ id: "cancelled", status: "cancelled" }),
        membership({ id: "old", ends_at: "2026-01-01T00:00:00.000Z" }),
      ],
      AT,
    );
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by("trial")).toMatchObject({ usable: true, reason: null });
    expect(by("spent")).toMatchObject({ usable: false, reason: "no credits left" });
    expect(by("cancelled")).toMatchObject({ usable: false, reason: "cancelled" });
    expect(by("old")).toMatchObject({ usable: false, reason: "not valid for this class" });
  });

  // The door reads these as prose ("Free trial · 0 left · used up"), so the
  // reason is lower-cased, but it is still the club's word for that ending: a
  // credit plan is used up, only a dated one expires.
  it("says a spent credit plan is used up, and a dated one expired", () => {
    const rows = attachableMemberships(
      [
        trial({ id: "spent-trial", status: "expired", sessions_remaining: 0 }),
        semester({ id: "over", status: "expired", ends_at: "2026-06-30T00:00:00.000Z" }),
      ],
      AT,
    );
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by("spent-trial")).toMatchObject({ usable: false, reason: "used up" });
    expect(by("over")).toMatchObject({ usable: false, reason: "expired" });
  });

  // The point of all of it: an uncovered check-in from a class someone really
  // attended can be attached to the trial they were given afterwards.
  it("lets a later-granted trial be attached to an earlier class", () => {
    const granted = trial({ starts_at: "2026-08-09T02:00:00.000Z", ends_at: null });
    const rows = attachableMemberships([granted], AT);
    expect(rows[0]).toMatchObject({ usable: true, reason: null });
  });

  it("says when a DATED membership starts after the class rather than just refusing it", () => {
    const rows = attachableMemberships(
      [
        semester({
          id: "later",
          starts_at: "2026-09-01T00:00:00.000Z",
          ends_at: "2026-12-14T00:00:00.000Z",
        }),
      ],
      AT,
    );
    expect(rows[0]).toMatchObject({ usable: false, reason: "starts after this class" });
  });

  it("never claims a membership is usable when attaching it would cover nothing", () => {
    const rows = attachableMemberships([trial({ sessions_remaining: 0 })], AT);
    expect(rows[0].usable).toBe(false);
    expect(
      resolveCoverage({ memberships: [trial({ sessions_remaining: 0 })], at: AT }).coverage,
    ).toBe("none");
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
