// The bug these pin: `memberships.status = 'expired'` is one stored word for
// two different endings, and the club was reading it out loud both times. A
// free trial is two classes, not a date, so it cannot expire; it gets used up.
import { describe, expect, it } from "vitest";
import { lifecycleLabel, membershipStatusLabel } from "./status-labels";

describe("membershipStatusLabel", () => {
  it("says a finished trial or class pack is used up, not expired", () => {
    expect(membershipStatusLabel({ status: "expired", kind: "trial" })).toBe("Used up");
    expect(membershipStatusLabel({ status: "expired", kind: "session" })).toBe("Used up");
  });

  it("keeps 'expired' for the plans that really do run out on a date", () => {
    expect(membershipStatusLabel({ status: "expired", kind: "period" })).toBe("Expired");
    expect(membershipStatusLabel({ status: "expired", kind: "insurance" })).toBe("Expired");
  });

  it("only renames the ending, never the other states", () => {
    expect(membershipStatusLabel({ status: "active", kind: "trial" })).toBe("Active");
    expect(membershipStatusLabel({ status: "pending", kind: "trial" })).toBe("Pending");
    expect(membershipStatusLabel({ status: "cancelled", kind: "trial" })).toBe("Cancelled");
  });

  it("falls back to the plain word when the plan could not be resolved", () => {
    // Several screens carry a row whose plan row is missing. Guessing "used up"
    // there would claim a class count the club may not have sold.
    expect(membershipStatusLabel({ status: "expired", kind: null })).toBe("Expired");
    expect(membershipStatusLabel({ status: "expired" })).toBe("Expired");
  });

  it("passes an unknown status straight through rather than blanking the pill", () => {
    expect(membershipStatusLabel({ status: "something_new", kind: "trial" })).toBe("something_new");
  });
});

describe("lifecycleLabel", () => {
  it("calls a used-up trial what it is, not a lapsed membership", () => {
    expect(lifecycleLabel("lapsed", "trial")).toBe("Trial used up");
  });

  it("keeps 'lapsed' for somebody whose paid membership ended", () => {
    expect(lifecycleLabel("lapsed", "period")).toBe("Lapsed");
    expect(lifecycleLabel("lapsed", "session")).toBe("Lapsed");
    expect(lifecycleLabel("lapsed", null)).toBe("Lapsed");
  });

  it("names the rest of the funnel unchanged", () => {
    expect(lifecycleLabel("lead")).toBe("Lead");
    expect(lifecycleLabel("applicant")).toBe("Applicant");
    expect(lifecycleLabel("visitor")).toBe("Visitor");
    expect(lifecycleLabel("member")).toBe("Member");
    // A trial is somebody's newest membership all the way through the funnel,
    // so the kind must not leak into any phase but the ended one.
    expect(lifecycleLabel("visitor", "trial")).toBe("Visitor");
    expect(lifecycleLabel("member", "trial")).toBe("Member");
  });
});
