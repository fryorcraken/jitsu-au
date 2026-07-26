import { describe, expect, it } from "vitest";
import {
  addMinutes,
  generateOccurrences,
  tzOffsetMinutes,
  weeklyOccurrenceDates,
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

describe("tzOffsetMinutes (Sydney DST)", () => {
  it("is +600 in winter (AEST) and +660 in summer (AEDT)", () => {
    expect(tzOffsetMinutes(new Date("2026-07-06T00:00:00Z"), SYDNEY)).toBe(600);
    expect(tzOffsetMinutes(new Date("2026-01-26T00:00:00Z"), SYDNEY)).toBe(660);
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
