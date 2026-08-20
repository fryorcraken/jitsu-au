// The bug these pin: `memberships.status = 'expired'` is one stored word for
// two different endings, and the club was reading it out loud both times. A
// free trial is two classes, not a date, so it cannot expire; it gets used up.
import { describe, expect, it } from "vitest";
import { isUsedUp, lifecycleLabel, membershipStatusLabel } from "./status-labels";

describe("membershipStatusLabel", () => {
  const spent = { status: "expired", sessions_remaining: 0 };

  it("says a finished trial or class pack is used up, not expired", () => {
    expect(membershipStatusLabel({ ...spent, kind: "trial" })).toBe("Used up");
    expect(membershipStatusLabel({ ...spent, kind: "session" })).toBe("Used up");
  });

  it("keeps 'expired' for the plans that really do run out on a date", () => {
    expect(membershipStatusLabel({ ...spent, kind: "period" })).toBe("Expired");
    expect(membershipStatusLabel({ ...spent, kind: "insurance" })).toBe("Expired");
  });

  it("does not say 'used up' while classes are still on the row", () => {
    // The state this guards is reachable from the check-in screen, not just by
    // hand: undoing a check-in refunds the credit but reopens the membership
    // only when THAT check-in is the one that closed it, so undoing an earlier
    // visit leaves `expired` with a class back on the row. A manager expiring a
    // never-used trial through edit_invoice lands in the same place. The screen
    // prints the balance next to this word, so it has to agree with it.
    expect(membershipStatusLabel({ status: "expired", kind: "trial", sessions_remaining: 1 })).toBe(
      "Expired",
    );
    expect(membershipStatusLabel({ status: "expired", kind: "trial", sessions_remaining: 2 })).toBe(
      "Expired",
    );
  });

  it("only renames the ending, never the other states", () => {
    expect(membershipStatusLabel({ status: "active", kind: "trial", sessions_remaining: 0 })).toBe(
      "Active",
    );
    expect(membershipStatusLabel({ status: "pending", kind: "trial", sessions_remaining: 0 })).toBe(
      "Pending",
    );
    expect(
      membershipStatusLabel({ status: "cancelled", kind: "trial", sessions_remaining: 0 }),
    ).toBe("Cancelled");
  });

  it("falls back to the plain word when the plan or the balance is unknown", () => {
    // Several screens carry a row whose plan row is missing, and a row sold as
    // a window has no balance at all. Guessing "used up" for either would claim
    // a class count the club may not have sold.
    expect(membershipStatusLabel({ ...spent, kind: null })).toBe("Expired");
    expect(membershipStatusLabel({ status: "expired", kind: "trial" })).toBe("Expired");
    expect(
      membershipStatusLabel({ status: "expired", kind: "trial", sessions_remaining: null }),
    ).toBe("Expired");
  });

  it("passes an unknown status straight through rather than blanking the pill", () => {
    expect(membershipStatusLabel({ status: "something_new", kind: "trial" })).toBe("something_new");
  });
});

describe("isUsedUp", () => {
  // The predicate the label and the funnel phase both hang off, so it is worth
  // pinning on its own: all three of ended, sold-as-classes, and none left.
  it("needs the row ended, sold as classes, and empty", () => {
    expect(isUsedUp({ status: "expired", kind: "trial", sessions_remaining: 0 })).toBe(true);
    expect(isUsedUp({ status: "active", kind: "trial", sessions_remaining: 0 })).toBe(false);
    expect(isUsedUp({ status: "expired", kind: "period", sessions_remaining: 0 })).toBe(false);
    expect(isUsedUp({ status: "expired", kind: "trial", sessions_remaining: 1 })).toBe(false);
  });
});

describe("lifecycleLabel", () => {
  const trial = (status: string, sessions_remaining = 0) => ({
    status,
    kind: "trial",
    sessions_remaining,
  });

  it("calls a used-up trial what it is, not a lapsed membership", () => {
    expect(lifecycleLabel("lapsed", trial("expired"))).toBe("Trial used up");
  });

  it("does not claim a CANCELLED trial was used up", () => {
    // `lapsed` is derived from expired OR cancelled. A trial a manager
    // cancelled may have both its classes sitting untouched, and its own row
    // (correctly) reads "Cancelled" right beside this pill.
    expect(lifecycleLabel("lapsed", trial("cancelled"))).toBe("Lapsed");
  });

  it("does not claim a trial was used up while classes remain on it", () => {
    // Same state as the membership-label case: refunded or hand-expired. The
    // phase pill sits beside a row that still shows the balance.
    expect(lifecycleLabel("lapsed", trial("expired", 1))).toBe("Lapsed");
  });

  it("keeps 'lapsed' for somebody whose paid membership ended", () => {
    expect(
      lifecycleLabel("lapsed", { status: "expired", kind: "period", sessions_remaining: null }),
    ).toBe("Lapsed");
    expect(
      lifecycleLabel("lapsed", { status: "expired", kind: "session", sessions_remaining: 0 }),
    ).toBe("Lapsed");
    expect(lifecycleLabel("lapsed", { status: "expired", kind: null, sessions_remaining: 0 })).toBe(
      "Lapsed",
    );
    expect(lifecycleLabel("lapsed")).toBe("Lapsed");
    expect(lifecycleLabel("lapsed", null)).toBe("Lapsed");
  });

  it("names the rest of the funnel unchanged", () => {
    expect(lifecycleLabel("lead")).toBe("Lead");
    expect(lifecycleLabel("applicant")).toBe("Applicant");
    expect(lifecycleLabel("visitor")).toBe("Visitor");
    expect(lifecycleLabel("member")).toBe("Member");
    // A trial is somebody's newest membership all the way through the funnel,
    // so it must not leak into any phase but the ended one.
    expect(lifecycleLabel("visitor", trial("active"))).toBe("Visitor");
    expect(lifecycleLabel("member", trial("expired"))).toBe("Member");
  });
});
