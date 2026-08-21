import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { beginnerDaysShort, scheduleDays, weeklySchedule } from "./schedule";

describe("the weekly schedule", () => {
  it("lists a day, a time and a note for every session", () => {
    expect(weeklySchedule.length).toBeGreaterThan(0);
    for (const session of weeklySchedule) {
      expect(session.day.trim().length).toBeGreaterThan(0);
      expect(session.time.trim().length).toBeGreaterThan(0);
      expect(session.note.trim().length).toBeGreaterThan(0);
    }
  });

  it("names each day once", () => {
    const days = weeklySchedule.map((s) => s.day);
    expect(new Set(days).size).toBe(days.length);
  });

  // AGENTS.md: no em dash in copy, en dash only for a numeric range.
  it("writes times with an en dash and no em dash anywhere in the copy", () => {
    for (const session of weeklySchedule) {
      expect(session.time, `${session.day} should use an en dash range`).toMatch(
        /^\d{1,2}:\d{2}(am|pm)? – \d{1,2}:\d{2}(am|pm)$/,
      );
      expect(`${session.day} ${session.note}`).not.toContain("—");
    }
  });

  // "from September" reads as next month every August, so the promise never
  // looks stale. A month in a note has to carry the year it belongs to.
  it("dates any month it names, so a stale promise shows as stale", () => {
    const months =
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
    for (const session of weeklySchedule) {
      if (!months.test(session.note)) continue;
      expect(session.note, `"${session.note}" needs the year`).toMatch(/\b20\d{2}\b/);
    }
  });

  it("has at least one session a beginner can walk into", () => {
    expect(weeklySchedule.some((s) => s.openToBeginners)).toBe(true);
  });
});

describe("days written out for a sentence", () => {
  it("lists every training day for the meta descriptions", () => {
    expect(scheduleDays).toBe("Monday, Wednesday and Saturday");
  });

  it("offers only the beginner-friendly nights, short form", () => {
    expect(beginnerDaysShort).toBe("Mon or Wed");
  });

  it("derives both from the schedule rather than restating it", () => {
    for (const session of weeklySchedule) {
      expect(scheduleDays).toContain(session.day);
      if (session.openToBeginners) expect(beginnerDaysShort).toContain(session.day.slice(0, 3));
      else expect(beginnerDaysShort).not.toContain(session.day.slice(0, 3));
    }
  });
});

// The drift this module exists to end: two pages each carrying their own copy
// of the schedule, agreeing on the times and disagreeing on the notes, with a
// green suite either way. A page that hardcodes a weekday is writing a third
// copy, so it fails here rather than in front of a prospective member.
describe("no page keeps its own copy of the schedule", () => {
  const ROUTES_DIR = resolve(import.meta.dirname, "..", "routes");
  const WEEKDAY_LITERAL =
    /"(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"|'(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)'/;

  const routeFiles = readdirSync(ROUTES_DIR, { recursive: true })
    .map(String)
    .filter((file) => /\.tsx?$/.test(file) && file !== "routeTree.gen.ts")
    .sort();

  it("has route files to check", () => {
    // A moved routes directory would turn the rule below into a test that
    // passes by finding no work.
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it("hardcodes no weekday under src/routes", () => {
    const offenders = routeFiles.filter((file) =>
      WEEKDAY_LITERAL.test(readFileSync(join(ROUTES_DIR, file), "utf8")),
    );
    expect(
      offenders,
      "read the schedule from @/lib/schedule (or weekday names from @/lib/calendar) instead of hardcoding one",
    ).toEqual([]);
  });
});
