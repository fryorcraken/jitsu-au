import { describe, expect, it } from "vitest";

import {
  INSURANCE_ENDED_CAP_DAYS,
  INSURANCE_ENDING_SOON_DAYS,
  coverEndDay,
  insuranceReminderCopy,
  insuranceReminderLabel,
  insuranceReminderTitle,
  insuranceRemindersDue,
  insuranceRenewHref,
  reminderNameFor,
  type InsuranceCover,
} from "./insurance-reminders";
import { clubDayStart } from "./validation";

/** 00:00 Sydney on a club date: where a year of cover dated by a manager ends. */
const endsOn = (day: string) => clubDayStart(day);

function cover(over: Partial<InsuranceCover> = {}): InsuranceCover {
  return {
    id: "m1",
    user_id: "ada",
    status: "active",
    ends_at: endsOn("2027-03-12"),
    ...over,
  };
}

/** Which reminder (if any) one membership is owed at `now`. */
function kindAt(c: InsuranceCover, now: string, others: InsuranceCover[] = []) {
  const due = insuranceRemindersDue([c, ...others], new Date(now)).filter(
    (d) => d.membershipId === c.id,
  );
  return due[0]?.kind ?? null;
}

describe("insuranceRemindersDue: the windows", () => {
  it("is 14 club days before the end, and the end day itself", () => {
    expect(INSURANCE_ENDING_SOON_DAYS).toBe(14);
    expect(INSURANCE_ENDED_CAP_DAYS).toBe(3);
    const c = cover(); // ends 12 March
    // 9am Sydney (AEDT, +11) on each day.
    expect(kindAt(c, "2027-02-24T22:00:00.000Z")).toBeNull(); // 25 Feb: 15 days
    expect(kindAt(c, "2027-02-25T22:00:00.000Z")).toBe("insurance_ending_soon"); // 26 Feb
    expect(kindAt(c, "2027-03-10T22:00:00.000Z")).toBe("insurance_ending_soon"); // 11 Mar
    expect(kindAt(c, "2027-03-11T22:00:00.000Z")).toBe("insurance_ended"); // 12 Mar
  });
});

describe("insuranceRemindersDue: club days, either side of a daylight-saving change", () => {
  // Sydney leaves daylight saving at 3am on Sunday 4 April 2027, so a window
  // counted in milliseconds would be an hour out across it, and an hour before
  // midnight is the previous day.
  const c = cover({ ends_at: endsOn("2027-04-10") });

  it("ends on the date the screens print", () => {
    expect(coverEndDay(c.ends_at!)).toBe("2027-04-10");
    // A year of cover bought at 2:30pm ends at 2:30pm, still on that date.
    expect(coverEndDay("2027-04-10T04:30:00.000Z")).toBe("2027-04-10");
  });

  it("starts the 14 days on 27 March (daylight time) for an end on 10 April (standard time)", () => {
    // 26 March, 9am AEDT: 15 days to go.
    expect(kindAt(c, "2027-03-25T22:00:00.000Z")).toBeNull();
    // 27 March, 12:30am AEDT: 14 days to go, though fewer than 14 x 24 hours.
    expect(kindAt(c, "2027-03-26T13:30:00.000Z")).toBe("insurance_ending_soon");
    // 9 April, 11:30pm AEST: the last day before it ends.
    expect(kindAt(c, "2027-04-09T13:30:00.000Z")).toBe("insurance_ending_soon");
  });

  it("is 'ended' from midnight on the end day, in Sydney", () => {
    // 10 April, 8am AEST. Still 9 April in UTC.
    expect(kindAt(c, "2027-04-09T22:00:00.000Z")).toBe("insurance_ended");
  });

  it("works the same way into daylight saving (4 October 2026)", () => {
    const oct = cover({ ends_at: endsOn("2026-10-10") });
    // 26 September, 11:30pm AEST: 14 days to go.
    expect(kindAt(oct, "2026-09-26T13:30:00.000Z")).toBe("insurance_ending_soon");
    // 25 September, 11:30pm AEST: 15.
    expect(kindAt(oct, "2026-09-25T13:30:00.000Z")).toBeNull();
    // 10 October, 12:30am AEDT.
    expect(kindAt(oct, "2026-10-09T13:30:00.000Z")).toBe("insurance_ended");
  });
});

describe("insuranceRemindersDue: the first-run cap", () => {
  // Without the cap the first run would email everybody whose insurance ran out
  // at any point in the club's history.
  const now = "2027-03-14T22:00:00.000Z"; // 15 March, 9am AEDT

  it("still sends 'ended' up to 3 days late, for a morning the job missed", () => {
    expect(kindAt(cover({ ends_at: endsOn("2027-03-15") }), now)).toBe("insurance_ended");
    expect(kindAt(cover({ ends_at: endsOn("2027-03-12") }), now)).toBe("insurance_ended");
  });

  it("sends nothing about cover that ended longer ago than that", () => {
    expect(kindAt(cover({ ends_at: endsOn("2027-03-11") }), now)).toBeNull();
    expect(kindAt(cover({ ends_at: endsOn("2025-01-01") }), now)).toBeNull();
  });

  it("sends nothing about cover ending more than 14 days out", () => {
    expect(kindAt(cover({ ends_at: endsOn("2027-03-30") }), now)).toBeNull();
    expect(kindAt(cover({ ends_at: endsOn("2027-03-29") }), now)).toBe("insurance_ending_soon");
  });
});

describe("insuranceRemindersDue: who is left out", () => {
  const now = "2027-03-01T22:00:00.000Z"; // 2 March: 10 days before 12 March

  it("reminds an unpaid one all the same: cover is about dates", () => {
    expect(kindAt(cover(), now)).toBe("insurance_ending_soon");
  });

  it("skips a cancelled membership, which a manager ended on purpose", () => {
    expect(kindAt(cover({ status: "cancelled" }), now)).toBeNull();
  });

  it("skips somebody who already holds cover that runs past the end", () => {
    const renewal = cover({ id: "m2", ends_at: endsOn("2028-03-12") });
    expect(kindAt(cover(), now, [renewal])).toBeNull();
  });

  it("still reminds them when the 'renewal' is cancelled, ends sooner, or is somebody else's", () => {
    const cancelled = cover({ id: "m2", status: "cancelled", ends_at: endsOn("2028-03-12") });
    const sooner = cover({ id: "m3", ends_at: endsOn("2027-03-10") });
    const strangers = cover({ id: "m4", user_id: "eve", ends_at: endsOn("2028-03-12") });
    expect(kindAt(cover(), now, [cancelled, sooner, strangers])).toBe("insurance_ending_soon");
  });

  it("does not count a 'pending' invoice as a renewal: it is a promise, not cover", () => {
    const pending = cover({ id: "m2", status: "pending", ends_at: endsOn("2028-03-12") });
    expect(kindAt(cover(), now, [pending])).toBe("insurance_ending_soon");
  });

  it("skips a row with no person or no end date", () => {
    expect(kindAt(cover({ user_id: null }), now)).toBeNull();
    expect(kindAt(cover({ ends_at: null }), now)).toBeNull();
  });
});

describe("insuranceReminderTitle", () => {
  it("is dated, because a row is read later than it is written", () => {
    expect(insuranceReminderTitle("insurance_ending_soon", "2027-03-12", null)).toBe(
      "Your club insurance ends on 12 March",
    );
    expect(insuranceReminderTitle("insurance_ended", "2027-03-12", "Bea")).toBe(
      "Bea's club insurance ended on 12 March",
    );
  });
});

describe("insuranceRenewHref", () => {
  it("opens /membership on the child the reminder is about", () => {
    expect(insuranceRenewHref(null)).toBe("/membership");
    expect(insuranceRenewHref("child-1")).toBe("/membership?for=child-1");
  });
});

describe("insuranceReminderCopy", () => {
  const today = "2027-02-26";
  const base = { endDay: "2027-03-12", today, hasEnded: false };

  it("speaks to the member about their own cover", () => {
    const copy = insuranceReminderCopy({
      ...base,
      kind: "insurance_ending_soon",
      people: [{ userId: "ada", name: null }],
    });
    expect(copy.subject).toBe("Your club insurance ends on 12 March");
    expect(copy.body).toContain("You need it to train with us, so renew before then.");
    expect(copy.body).toContain("choose Yearly insurance");
    expect(copy.renewHref).toBe("/membership");
  });

  it("says 'ended today' only on the day it ends, and only once it has", () => {
    const people = [{ userId: "ada", name: null }];
    const onTheDay = { kind: "insurance_ended" as const, endDay: today, today, people };
    expect(insuranceReminderCopy({ ...onTheDay, hasEnded: true }).subject).toBe(
      "Your club insurance ended today",
    );
    // A year bought at 7pm still runs when the 9am job sends this.
    const stillRunning = insuranceReminderCopy({ ...onTheDay, hasEnded: false });
    expect(stillRunning.subject).toBe("Your club insurance ends today");
    expect(stillRunning.body).toContain("so renew today.");
    expect(
      insuranceReminderCopy({ ...onTheDay, endDay: "2027-02-24", hasEnded: true }).subject,
    ).toBe("Your club insurance ended on 24 February");
  });

  it("names a child, and opens the page on them", () => {
    const copy = insuranceReminderCopy({
      ...base,
      kind: "insurance_ending_soon",
      people: [{ userId: "bea", name: "Bea" }],
    });
    expect(copy.subject).toBe("Bea's club insurance ends on 12 March");
    expect(copy.body).toContain("It is needed to train with us");
    expect(copy.renewHref).toBe("/membership?for=bea");
  });

  it("never words a nameless child's cover as the reader's own", () => {
    const copy = insuranceReminderCopy({
      ...base,
      kind: "insurance_ending_soon",
      people: [{ userId: "bea", name: reminderNameFor("  ") }],
    });
    expect(copy.subject).toBe("Your family member's club insurance ends on 12 March");
    expect(copy.renewHref).toBe("/membership?for=bea");
  });

  it("keeps the fallback name lower case mid-sentence", () => {
    const copy = insuranceReminderCopy({
      ...base,
      kind: "insurance_ending_soon",
      people: [
        { userId: "ada", name: null },
        { userId: "bea", name: reminderNameFor("") },
      ],
    });
    expect(copy.subject).toBe("Club insurance for you and your family member ends on 12 March");
  });

  it("names everybody in one email when several end the same day, the reader first", () => {
    const two = insuranceReminderCopy({
      ...base,
      kind: "insurance_ending_soon",
      people: [
        { userId: "cy", name: "Cy" },
        { userId: "bea", name: "Bea" },
      ],
    });
    expect(two.subject).toBe("Club insurance for Bea and Cy ends on 12 March");
    // Opens on the first child named; the page's own picker reaches the other.
    expect(two.renewHref).toBe("/membership?for=bea");

    const withParent = insuranceReminderCopy({
      kind: "insurance_ended",
      endDay: today,
      today,
      hasEnded: true,
      people: [
        { userId: "bea", name: "Bea" },
        { userId: "ada", name: null },
        { userId: "cy", name: "Cy" },
      ],
    });
    expect(withParent.subject).toBe("Club insurance for you, Bea and Cy ended today");
    expect(withParent.renewHref).toBe("/membership");
  });
});

describe("insuranceReminderTitle on the end day", () => {
  it("says 'ends' on the end day until the cover has actually run out", () => {
    expect(insuranceReminderTitle("insurance_ended", "2027-03-12", null, false)).toBe(
      "Your club insurance ends on 12 March",
    );
    expect(insuranceReminderTitle("insurance_ended", "2027-03-12", null, true)).toBe(
      "Your club insurance ended on 12 March",
    );
  });
});

describe("insuranceReminderLabel", () => {
  it("says which reminder went out and when, in Sydney", () => {
    expect(
      insuranceReminderLabel({
        ends_within_14_days: true,
        owed: "insurance_ending_soon",
        // 26 Feb, 9am in Sydney; still 25 Feb in UTC.
        last_sent: { kind: "insurance_ending_soon", sent_at: "2027-02-25T22:00:06Z" },
      }),
    ).toBe("14-day reminder sent 26 Feb");
    expect(
      insuranceReminderLabel({
        ends_within_14_days: false,
        owed: "insurance_ended",
        last_sent: { kind: "insurance_ended", sent_at: "2027-03-11T22:00:06Z" },
      }),
    ).toBe("Ended reminder sent 12 Mar");
  });

  it("says a reminder is owed but not sent, even after the other one went out", () => {
    expect(
      insuranceReminderLabel({
        ends_within_14_days: true,
        owed: "insurance_ending_soon",
        last_sent: null,
      }),
    ).toBe("Reminder not sent yet");
    expect(
      insuranceReminderLabel({
        ends_within_14_days: false,
        owed: "insurance_ended",
        last_sent: { kind: "insurance_ending_soon", sent_at: "2027-02-25T22:00:06Z" },
      }),
    ).toBe("Ended reminder not sent yet");
  });

  it("says nothing when nothing is owed or sent", () => {
    expect(
      insuranceReminderLabel({ ends_within_14_days: false, owed: null, last_sent: null }),
    ).toBeNull();
    expect(insuranceReminderLabel(null)).toBeNull();
  });
});
