import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_LOCATION,
  addMinutes,
  clubLocalDate,
  clubLocalDateTime,
  clubLocalToIso,
  defaultEndForStart,
  diffOccurrences,
  firstDateToCome,
  generateOccurrences,
  tzOffsetMinutes,
  weeklyOccurrenceDates,
  weeklyRunsShareADate,
  zonedWallTimeToUtc,
} from "./calendar";

const SYDNEY = "Australia/Sydney";

describe("weeklyOccurrenceDates", () => {
  it("returns every matching weekday in range, inclusive", () => {
    // Mondays in July 2026: 6, 13, 20, 27.
    const mondays = weeklyOccurrenceDates(1, "2026-07-01", "2026-07-31");
    expect(mondays).toEqual(["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"]);
  });

  it("every returned date really falls on the requested weekday", () => {
    const saturdays = weeklyOccurrenceDates(6, "2026-07-01", "2026-08-31");
    expect(saturdays.every((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 6)).toBe(true);
  });

  it("returns nothing when the range is inverted", () => {
    expect(weeklyOccurrenceDates(1, "2026-07-31", "2026-07-01")).toEqual([]);
  });
});

// Dates are only ever generated from today on, so a weekly entry is judged on
// the dates it will actually put on the calendar, not the ones typed into it.
// Monday 2 November 2026 throughout.
const TODAY = "2026-11-02";
const MONDAY = 1;
const WEDNESDAY = 3;

describe("firstDateToCome", () => {
  it("snaps a run that starts later forward to its weekday", () => {
    // Wednesday 4 November: the first Monday on or after it.
    expect(
      firstDateToCome({ weekday: MONDAY, starts_on: "2026-11-04", ends_on: null }, TODAY),
    ).toBe("2026-11-09");
  });

  it("starts a run that began in the past from today, not from its first date", () => {
    const sinceSeptember = { starts_on: "2026-09-07", ends_on: null };
    expect(firstDateToCome({ ...sinceSeptember, weekday: WEDNESDAY }, TODAY)).toBe("2026-11-04");
    // Today is itself a Monday, and today is still to come.
    expect(firstDateToCome({ ...sinceSeptember, weekday: MONDAY }, TODAY)).toBe(TODAY);
  });

  it("counts a last date that falls on the weekday", () => {
    expect(
      firstDateToCome({ weekday: MONDAY, starts_on: "2026-11-03", ends_on: "2026-11-09" }, TODAY),
    ).toBe("2026-11-09");
  });

  it("is null when the run ends before its first matching weekday", () => {
    // Tuesday 3 to Sunday 8 November holds no Monday.
    expect(
      firstDateToCome({ weekday: MONDAY, starts_on: "2026-11-03", ends_on: "2026-11-08" }, TODAY),
    ).toBeNull();
  });

  it("is null when the run's last date has already passed", () => {
    expect(
      firstDateToCome({ weekday: MONDAY, starts_on: "2026-07-13", ends_on: "2026-10-30" }, TODAY),
    ).toBeNull();
  });

  it("is never null for a run with no last date, whatever the day or start", () => {
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      for (const starts_on of ["2026-01-01", TODAY, "2027-06-30"]) {
        const first = firstDateToCome({ weekday, starts_on, ends_on: null }, TODAY);
        expect(first).not.toBeNull();
        expect(new Date(`${first}T00:00:00Z`).getUTCDay()).toBe(weekday);
      }
    }
  });
});

// Whether adding a weekly run would double up a class that is already there.
// Both runs share a weekday (the database lookup already matched on it), so
// `existing` carries only its dates.
describe("weeklyRunsShareADate", () => {
  const mondays = (starts_on: string, ends_on: string | null) => ({
    weekday: MONDAY,
    starts_on,
    ends_on,
  });

  it("is true for two runs that hold the same Mondays", () => {
    expect(
      weeklyRunsShareADate(
        { starts_on: "2026-09-07", ends_on: "2026-12-14" },
        mondays("2026-11-09", "2027-02-01"),
        TODAY,
      ),
    ).toBe(true);
  });

  // Tue 10 to Sun 15 Nov holds no Monday, so it can clash with nothing. New
  // runs like it are refused as no_dates, but rows from before that rule exist.
  it("is false against an existing run that holds no such weekday at all", () => {
    expect(
      weeklyRunsShareADate(
        { starts_on: "2026-11-10", ends_on: "2026-11-15" },
        mondays("2026-11-02", null),
        TODAY,
      ),
    ).toBe(false);
  });

  it("is false for next semester's run, which starts after this one's last date", () => {
    expect(
      weeklyRunsShareADate(
        { starts_on: "2026-07-13", ends_on: "2026-11-23" },
        mondays("2027-02-22", null),
        TODAY,
      ),
    ).toBe(false);
  });

  it("is false for this semester's run added after next semester's is already there", () => {
    expect(
      weeklyRunsShareADate(
        { starts_on: "2027-02-22", ends_on: null },
        mondays(TODAY, "2026-11-30"),
        TODAY,
      ),
    ).toBe(false);
  });

  // The typed dates overlap on Friday 27 November, but the old run's last
  // Monday is the 23rd and the new run's first is the 30th.
  it("is false when the old run ends on a Friday and the new one starts that Friday", () => {
    const endsFriday = { starts_on: "2026-09-07", ends_on: "2026-11-27" };
    expect(weeklyRunsShareADate(endsFriday, mondays("2026-11-27", null), TODAY)).toBe(false);
    // One day earlier is a Monday the old run still has.
    expect(weeklyRunsShareADate(endsFriday, mondays("2026-11-23", null), TODAY)).toBe(true);
  });

  // A run whose last date has passed still counts as active until somebody
  // stops it, but it will never hold another class.
  it("is false against a run that is over, even when the new run is backdated into it", () => {
    expect(
      weeklyRunsShareADate(
        { starts_on: "2026-07-13", ends_on: "2026-10-26" },
        mondays("2026-10-01", null),
        TODAY,
      ),
    ).toBe(false);
  });

  it("is true against a run with no last date, however far out the new one starts", () => {
    expect(
      weeklyRunsShareADate(
        { starts_on: "2026-09-07", ends_on: null },
        mondays("2027-03-01", "2027-05-31"),
        TODAY,
      ),
    ).toBe(true);
  });

  it("is false for a new run that would put no date on the calendar", () => {
    const openEnded = { starts_on: "2026-09-07", ends_on: null };
    // Over already.
    expect(weeklyRunsShareADate(openEnded, mondays("2026-07-13", "2026-10-30"), TODAY)).toBe(false);
    // Tuesday to Sunday: no Monday in it.
    expect(weeklyRunsShareADate(openEnded, mondays("2026-11-03", "2026-11-08"), TODAY)).toBe(false);
  });
});

describe("tzOffsetMinutes (Sydney DST)", () => {
  it("is +600 in winter (AEST) and +660 in summer (AEDT)", () => {
    expect(tzOffsetMinutes(new Date("2026-07-06T00:00:00Z"), SYDNEY)).toBe(600);
    expect(tzOffsetMinutes(new Date("2026-01-26T00:00:00Z"), SYDNEY)).toBe(660);
  });
});

describe("clubLocalDate", () => {
  it("gives the club's date, not UTC's, for a Sydney morning", () => {
    // 09:00 Sydney on 5 Aug is still 4 Aug in UTC.
    expect(clubLocalDate(new Date("2026-08-04T23:00:00Z"), SYDNEY)).toBe("2026-08-05");
  });

  it("holds across midnight at the club", () => {
    expect(clubLocalDate(new Date("2026-08-04T14:00:00Z"), SYDNEY)).toBe("2026-08-05");
    expect(clubLocalDate(new Date("2026-08-04T13:59:00Z"), SYDNEY)).toBe("2026-08-04");
  });

  it("uses the offset in force at the instant, so daylight saving cannot shift it", () => {
    // AEDT (+11) on 4 Apr 2026, AEST (+10) the day after the change.
    expect(clubLocalDate(new Date("2026-04-04T13:30:00Z"), SYDNEY)).toBe("2026-04-05");
    expect(clubLocalDate(new Date("2026-07-05T14:30:00Z"), SYDNEY)).toBe("2026-07-06");
  });
});

describe("zonedWallTimeToUtc", () => {
  it("maps a Sydney wall-clock time to the correct UTC instant across DST", () => {
    // Winter: AEST (UTC+10) -> 18:00 local is 08:00Z.
    expect(zonedWallTimeToUtc("2026-07-06", "18:00", SYDNEY).toISOString()).toBe(
      "2026-07-06T08:00:00.000Z",
    );
    // Summer: AEDT (UTC+11) -> 18:00 local is 07:00Z.
    expect(zonedWallTimeToUtc("2026-01-26", "18:00", SYDNEY).toISOString()).toBe(
      "2026-01-26T07:00:00.000Z",
    );
  });
});

// The manager calendar's pickers and the manager agent API's one-off times both
// arrive as club wall-clock time, and the agent reads them back through
// clubLocalDateTime, so the two have to agree with each other on either side of
// a daylight saving change, not just with the zone in the middle of a season.
describe("clubLocalToIso", () => {
  it("reads a summer evening as daylight time (AEDT, +11)", () => {
    expect(clubLocalToIso("2026-11-05T18:00")).toBe("2026-11-05T07:00:00.000Z");
  });

  it("reads a winter evening as standard time (AEST, +10)", () => {
    expect(clubLocalToIso("2026-06-04T18:00")).toBe("2026-06-04T08:00:00.000Z");
  });

  // A picker can emit seconds, and a minute-resolution calendar has no use for
  // them: they are dropped, not rounded.
  it("ignores seconds", () => {
    expect(clubLocalToIso("2026-11-05T18:00:00")).toBe("2026-11-05T07:00:00.000Z");
    expect(clubLocalToIso("2026-11-05T18:00:59")).toBe("2026-11-05T07:00:00.000Z");
  });

  it("reads the club's zone unless told another", () => {
    expect(clubLocalToIso("2026-11-05T18:00", "UTC")).toBe("2026-11-05T18:00:00.000Z");
  });
});

describe("clubLocalDateTime", () => {
  it("gives the club's wall clock, not UTC's, on both sides of daylight saving", () => {
    expect(clubLocalDateTime(new Date("2026-11-05T07:00:00Z"))).toBe("2026-11-05T18:00");
    expect(clubLocalDateTime(new Date("2026-06-04T08:00:00Z"))).toBe("2026-06-04T18:00");
  });

  // A 07:30 Sydney class is still the previous evening in UTC.
  it("lands a morning class on the club's day", () => {
    expect(clubLocalDateTime(new Date("2026-11-04T20:30:00Z"))).toBe("2026-11-05T07:30");
    expect(clubLocalDateTime(new Date("2026-06-03T21:30:00Z"))).toBe("2026-06-04T07:30");
  });

  it("is the inverse of clubLocalToIso in either season", () => {
    for (const local of [
      "2026-11-05T18:00",
      "2026-06-04T18:00",
      "2026-11-05T07:30",
      "2026-06-04T00:00",
      "2026-12-31T23:59",
    ]) {
      expect(clubLocalDateTime(new Date(clubLocalToIso(local)))).toBe(local);
    }
  });

  // Sydney springs forward at 02:00 on 4 October 2026 (02:00-02:59 never
  // happens) and falls back at 03:00 on 4 April 2027 (02:00-02:59 happens
  // twice). The hour either side of each change has exactly one meaning, and
  // the round trip has to land on it.
  it("round-trips the hour either side of the October 2026 change", () => {
    expect(clubLocalToIso("2026-10-04T01:00")).toBe("2026-10-03T15:00:00.000Z"); // AEST
    expect(clubLocalToIso("2026-10-04T03:00")).toBe("2026-10-03T16:00:00.000Z"); // AEDT
    expect(clubLocalDateTime(new Date("2026-10-03T15:00:00Z"))).toBe("2026-10-04T01:00");
    expect(clubLocalDateTime(new Date("2026-10-03T16:00:00Z"))).toBe("2026-10-04T03:00");
  });

  it("round-trips the hour either side of the April 2027 change", () => {
    expect(clubLocalToIso("2027-04-04T01:00")).toBe("2027-04-03T14:00:00.000Z"); // AEDT
    expect(clubLocalToIso("2027-04-04T03:00")).toBe("2027-04-03T17:00:00.000Z"); // AEST
    expect(clubLocalDateTime(new Date("2027-04-03T14:00:00Z"))).toBe("2027-04-04T01:00");
    expect(clubLocalDateTime(new Date("2027-04-03T17:00:00Z"))).toBe("2027-04-04T03:00");
  });
});

describe("addMinutes", () => {
  it("adds without mutating the input", () => {
    const start = new Date("2026-07-06T08:00:00Z");
    expect(addMinutes(start, 90).toISOString()).toBe("2026-07-06T09:30:00.000Z");
    expect(start.toISOString()).toBe("2026-07-06T08:00:00.000Z");
  });
});

describe("generateOccurrences", () => {
  it("clamps to the series' own start/end and builds UTC instants", () => {
    const occ = generateOccurrences(
      {
        weekday: 1,
        start_time: "18:00",
        duration_minutes: 60,
        starts_on: "2026-07-13",
        ends_on: "2026-07-20",
      },
      "2026-07-01",
      "2026-07-31",
      SYDNEY,
    );
    expect(occ).toEqual([
      { starts_at: "2026-07-13T08:00:00.000Z", ends_at: "2026-07-13T09:00:00.000Z" },
      { starts_at: "2026-07-20T08:00:00.000Z", ends_at: "2026-07-20T09:00:00.000Z" },
    ]);
  });

  it("handles an open-ended series (null ends_on) within the window", () => {
    const occ = generateOccurrences(
      {
        weekday: 1,
        start_time: "18:00",
        duration_minutes: 60,
        starts_on: "2026-07-01",
        ends_on: null,
      },
      "2026-07-01",
      "2026-07-20",
      SYDNEY,
    );
    expect(occ.map((o) => o.starts_at)).toEqual([
      "2026-07-06T08:00:00.000Z",
      "2026-07-13T08:00:00.000Z",
      "2026-07-20T08:00:00.000Z",
    ]);
  });
});

describe("zonedWallTimeToUtc across a DST transition", () => {
  // Sydney springs forward 2026-10-04 (AEST +10 -> AEDT +11). These exercise the
  // second pass in zonedWallTimeToUtc, which the in-season cases never reach.
  it("resolves times either side of the spring-forward boundary", () => {
    // Clocks jump at 02:00, so 01:30 that morning is still AEST (+10).
    expect(zonedWallTimeToUtc("2026-10-04", "01:30", SYDNEY).toISOString()).toBe(
      "2026-10-03T15:30:00.000Z",
    );
    // The evening of the same day is firmly AEDT.
    expect(zonedWallTimeToUtc("2026-10-04", "18:00", SYDNEY).toISOString()).toBe(
      "2026-10-04T07:00:00.000Z",
    );
    // The day before is still AEST (+10).
    expect(zonedWallTimeToUtc("2026-10-03", "18:00", SYDNEY).toISOString()).toBe(
      "2026-10-03T08:00:00.000Z",
    );
  });

  it("keeps a weekly series at the same club wall-clock time across the change", () => {
    // A Monday 18:00 class must stay 18:00 locally, which means its UTC instant
    // shifts by an hour when Sydney moves to daylight time.
    const occ = generateOccurrences(
      {
        weekday: 1,
        start_time: "18:00",
        duration_minutes: 60,
        starts_on: "2026-09-28",
        ends_on: "2026-10-12",
      },
      "2026-09-01",
      "2026-10-31",
      SYDNEY,
    );
    expect(occ.map((o) => o.starts_at)).toEqual([
      "2026-09-28T08:00:00.000Z", // AEST (+10)
      "2026-10-05T07:00:00.000Z", // AEDT (+11)
      "2026-10-12T07:00:00.000Z",
    ]);
  });
});

describe("diffOccurrences", () => {
  const occ = [
    { starts_at: "2026-07-06T08:00:00.000Z", ends_at: "2026-07-06T09:00:00.000Z" },
    { starts_at: "2026-07-13T08:00:00.000Z", ends_at: "2026-07-13T09:00:00.000Z" },
  ];

  it("returns everything when nothing exists yet", () => {
    expect(diffOccurrences([], occ)).toEqual(occ);
  });

  it("skips occurrences that already exist", () => {
    expect(diffOccurrences([{ starts_at: "2026-07-06T08:00:00.000Z" }], occ)).toEqual([occ[1]]);
  });

  it("matches on the instant, not the string spelling", () => {
    // Postgres commonly returns +00:00 rather than Z; the same moment must not
    // be re-inserted as a duplicate calendar entry.
    expect(diffOccurrences([{ starts_at: "2026-07-06T08:00:00+00:00" }], occ)).toEqual([occ[1]]);
  });

  it("is a no-op when every occurrence is already present (repeat generation)", () => {
    expect(diffOccurrences(occ, occ)).toEqual([]);
  });
});

describe("defaultEndForStart", () => {
  it("fills an empty end with an hour after the start", () => {
    expect(defaultEndForStart("2026-08-10T18:00", "", false)).toBe("2026-08-10T19:00");
  });

  it("keeps an end the manager typed themselves", () => {
    expect(defaultEndForStart("2026-08-10T18:00", "2026-08-10T20:30", true)).toBe(
      "2026-08-10T20:30",
    );
  });

  it("follows the start when the end is only the one it derived", () => {
    // The bug this guards: 18:00 auto-fills 19:00, the manager then corrects the
    // start to 09:00, and a derived end left alone would save a nine-hour entry.
    expect(defaultEndForStart("2026-08-10T09:00", "2026-08-10T19:00", false)).toBe(
      "2026-08-10T10:00",
    );
    // Later in the day, same rule.
    expect(defaultEndForStart("2026-08-10T20:00", "2026-08-10T19:00", false)).toBe(
      "2026-08-10T21:00",
    );
  });

  it("re-derives even a hand-typed end once the start has overtaken it", () => {
    // Moving the start past the end would make the entry backwards, which the
    // server rejects, so the manager's answer cannot survive here.
    expect(defaultEndForStart("2026-08-11T18:00", "2026-08-10T19:00", true)).toBe(
      "2026-08-11T19:00",
    );
    // Same instant counts as overtaken: an entry has to have some length.
    expect(defaultEndForStart("2026-08-10T18:00", "2026-08-10T18:00", true)).toBe(
      "2026-08-10T19:00",
    );
  });

  it("rolls over midnight rather than inventing a same-day end", () => {
    expect(defaultEndForStart("2026-08-10T23:30", "", false)).toBe("2026-08-11T00:30");
  });

  it("leaves the end alone until a start is picked", () => {
    expect(defaultEndForStart("", "2026-08-10T19:00", true)).toBe("2026-08-10T19:00");
    expect(defaultEndForStart("", "2026-08-10T19:00", false)).toBe("2026-08-10T19:00");
    expect(defaultEndForStart("", "", false)).toBe("");
    // A half-typed date (the picker emits partial values while editing).
    expect(defaultEndForStart("2026-08", "2026-08-10T19:00", false)).toBe("2026-08-10T19:00");
  });

  it("fills an end back in when the manager clears the one they typed", () => {
    expect(defaultEndForStart("2026-08-10T18:00", "", true)).toBe("2026-08-10T19:00");
  });

  it("tolerates a value that carries seconds", () => {
    expect(defaultEndForStart("2026-08-10T18:00:00", "", false)).toBe("2026-08-10T19:00");
  });
});

describe("DEFAULT_EVENT_LOCATION", () => {
  it("is the gym the club trains at, spelled out to the building", () => {
    // Composed from the shared venue constants, so a rename or a corrected
    // address reaches the calendar too instead of being restated here.
    expect(DEFAULT_EVENT_LOCATION).toBe(
      "ActivateFit Gym, UTS Building 4, 745 Harris Street, Ultimo NSW 2007",
    );
  });
});
