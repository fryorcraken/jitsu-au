import { describe, expect, it } from "vitest";
import {
  buildCalendar,
  escapeIcsText,
  foldIcsLine,
  formatUtcDate,
  formatUtcStamp,
  veventLines,
  type IcsEvent,
} from "./ics";

describe("escapeIcsText", () => {
  it("escapes backslashes, commas, semicolons and newlines", () => {
    expect(escapeIcsText("a, b; c\\d")).toBe("a\\, b\\; c\\\\d");
    expect(escapeIcsText("line1\nline2")).toBe("line1\\nline2");
    expect(escapeIcsText("crlf\r\nhere")).toBe("crlf\\nhere");
  });
});

describe("formatUtcStamp / formatUtcDate", () => {
  it("emits UTC date-time and date values", () => {
    const d = new Date("2026-01-26T07:00:00Z");
    expect(formatUtcStamp(d)).toBe("20260126T070000Z");
    expect(formatUtcDate(d)).toBe("20260126");
  });
});

describe("foldIcsLine", () => {
  it("leaves short lines untouched", () => {
    expect(foldIcsLine("SUMMARY:hi")).toBe("SUMMARY:hi");
  });
  it("folds long lines at 75 octets with CRLF + space continuation", () => {
    const long = "DESCRIPTION:" + "x".repeat(200);
    const folded = foldIcsLine(long);
    const rows = folded.split("\r\n");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].length).toBe(75);
    // Continuations start with a single space.
    expect(rows.slice(1).every((r) => r.startsWith(" "))).toBe(true);
  });
});

describe("veventLines", () => {
  const base: IcsEvent = {
    uid: "abc@jitsu.au",
    start: new Date("2026-07-06T08:00:00Z"),
    end: new Date("2026-07-06T09:00:00Z"),
    summary: "Beginner Gi",
    location: "UTS Ultimo",
  };
  const stamp = new Date("2026-07-01T00:00:00Z");

  it("emits a confirmed timed event", () => {
    const lines = veventLines(base, stamp);
    expect(lines).toContain("UID:abc@jitsu.au");
    expect(lines).toContain("DTSTART:20260706T080000Z");
    expect(lines).toContain("DTEND:20260706T090000Z");
    expect(lines).toContain("STATUS:CONFIRMED");
    expect(lines).toContain("SUMMARY:Beginner Gi");
  });

  it("marks cancelled events STATUS:CANCELLED so subscribers drop them", () => {
    const lines = veventLines({ ...base, cancelled: true, sequence: 2 }, stamp);
    expect(lines).toContain("STATUS:CANCELLED");
    expect(lines).toContain("SEQUENCE:2");
  });

  it("uses DATE values for all-day events", () => {
    const lines = veventLines({ ...base, allDay: true }, stamp);
    expect(lines).toContain("DTSTART;VALUE=DATE:20260706");
  });
});

describe("buildCalendar", () => {
  const ev: IcsEvent = {
    uid: "abc@jitsu.au",
    start: new Date("2026-07-06T08:00:00Z"),
    end: new Date("2026-07-06T09:00:00Z"),
    summary: "Beginner Gi",
  };

  it("wraps events in a VCALENDAR with the requested method and CRLF lines", () => {
    const out = buildCalendar({ events: [ev], method: "PUBLISH", now: new Date("2026-07-01Z") });
    expect(out.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(out).toContain("METHOD:PUBLISH");
    expect(out).toContain("BEGIN:VEVENT");
    expect(out.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("supports CANCEL for invite retraction", () => {
    const out = buildCalendar({ events: [{ ...ev, cancelled: true }], method: "CANCEL" });
    expect(out).toContain("METHOD:CANCEL");
    expect(out).toContain("STATUS:CANCELLED");
  });
});
