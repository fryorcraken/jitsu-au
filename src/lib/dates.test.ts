import { describe, expect, it } from "vitest";
import { EMPTY, formatDate, formatDateOnly, formatDateTime } from "./dates";

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
