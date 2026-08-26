import { describe, expect, it } from "vitest";
import { EMPTY, describeWhen, formatDate, formatDateOnly, formatDateTime } from "./dates";

describe("formatDate", () => {
  it("shows the empty glyph for a missing date", () => {
    // The drift this replaced: a missing date read "none" on the user list and
    // "—" on the person page, for the same waiver column.
    expect(formatDate(null)).toBe(EMPTY);
    expect(formatDate(undefined)).toBe(EMPTY);
    expect(EMPTY).toBe("—");
  });

  it("renders a timestamp as a date", () => {
    const out = formatDate("2026-07-29T02:57:18.000Z");
    expect(out).not.toBe(EMPTY);
    expect(out).toContain("2026");
  });
});

describe("formatDateTime", () => {
  it("shows the empty glyph for a missing timestamp", () => {
    expect(formatDateTime(null)).toBe(EMPTY);
  });

  it("includes a time of day", () => {
    const out = formatDateTime("2026-07-29T02:57:18.000Z");
    expect(out).toContain("2026");
    expect(out).toMatch(/\d:\d\d/);
  });
});

describe("formatDateOnly", () => {
  it("reads a DATE column as written, with no timezone shift", () => {
    // `new Date("1990-04-05")` is UTC midnight, which is 04/04 for anyone west
    // of Greenwich. A date of birth has no timezone, so parse the parts.
    expect(formatDateOnly("1990-04-05")).toBe("05/04/1990");
  });

  it("shows the empty glyph for a missing date", () => {
    expect(formatDateOnly(null)).toBe(EMPTY);
    expect(formatDateOnly("")).toBe(EMPTY);
  });

  it("passes through anything that is not a plain YYYY-MM-DD", () => {
    expect(formatDateOnly("1990-04-05T00:00:00Z")).toBe("1990-04-05T00:00:00Z");
  });
});

describe("describeWhen", () => {
  // Fixed local times: a draft banner is read by a person in Sydney looking at
  // their own clock, so these are built in local time on purpose.
  const now = new Date(2026, 7, 26, 14, 0, 0).getTime();

  it("gives just the time for something written today", () => {
    const earlier = new Date(2026, 7, 26, 9, 30, 0).getTime();
    expect(describeWhen(earlier, now)).toMatch(/9:30/);
    expect(describeWhen(earlier, now)).not.toMatch(/yesterday|Aug/);
  });

  it("says yesterday rather than a date", () => {
    const yesterday = new Date(2026, 7, 25, 21, 5, 0).getTime();
    expect(describeWhen(yesterday, now)).toMatch(/^yesterday at /);
  });

  it("gives a date for anything older", () => {
    // The point of the distinction: knowing whether this is the work you just
    // lost or something you had forgotten about.
    const older = new Date(2026, 7, 20, 11, 15, 0).getTime();
    expect(describeWhen(older, now)).toMatch(/20 Aug at /);
  });

  it("treats a draft written a minute after midnight as today", () => {
    const justAfterMidnight = new Date(2026, 7, 26, 0, 1, 0).getTime();
    expect(describeWhen(justAfterMidnight, now)).not.toMatch(/yesterday/);
  });
});
