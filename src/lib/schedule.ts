// Single source of truth for the weekly class schedule.
//
// It used to live as a hand-kept array in `routes/classes.tsx` and a second,
// inline one in `routes/index.tsx`, and they had already drifted: the classes
// page said "All levels welcome" on Monday and Wednesday, the homepage said
// nothing, and there was no way to notice. A third copy was spelled out in
// prose on the register-interest confirmation ("Mon or Wed"). One list here,
// read by all three, is what stops a schedule change from being a change
// somebody has to remember to make in four places.
//
// This is copy, not data. The calendar (`docs/calendar.md`) holds the real,
// manager-editable entries with dates and RSVPs; these three lines are the
// at-a-glance version a prospective member reads before they have an account.
//
// `schedule.test.ts` also refuses a weekday literal anywhere under
// `src/routes/`, so re-hardcoding the schedule on a page fails the suite
// instead of drifting quietly.

export type ClassSession = {
  /** Weekday name, as printed on screen. */
  day: string;
  /**
   * Local time range. The en dash is deliberate: `AGENTS.md` bans the em dash
   * in copy but keeps the en dash for numeric ranges.
   */
  time: string;
  /** Who the session is for, printed under the time. */
  note: string;
  /**
   * True where someone with no experience can just turn up. Drives the prose
   * on the register-interest confirmation, so adding a beginners night updates
   * that sentence too.
   */
  openToBeginners: boolean;
};

export const weeklySchedule: ClassSession[] = [
  { day: "Monday", time: "5:30 – 7:00pm", note: "All levels welcome", openToBeginners: true },
  { day: "Wednesday", time: "6:00 – 7:30pm", note: "All levels welcome", openToBeginners: true },
  {
    day: "Saturday",
    time: "11:00am – 12:30pm",
    // The year is not decoration. Without it this reads as "next month" every
    // August, so a promise that never arrived would look fresh forever.
    note: "Colour belts only, from September 2026",
    openToBeginners: false,
  },
];

/** "Monday, Wednesday and Saturday" / "Mon or Wed": days written out for a sentence. */
function joinDays(days: string[], conjunction: "and" | "or"): string {
  if (days.length < 2) return days.join("");
  return `${days.slice(0, -1).join(", ")} ${conjunction} ${days[days.length - 1]}`;
}

/** Every training day, for meta descriptions: "Monday, Wednesday and Saturday". */
export const scheduleDays = joinDays(
  weeklySchedule.map((s) => s.day),
  "and",
);

/** The nights a beginner can walk into, short form for tight prose: "Mon or Wed". */
export const beginnerDaysShort = joinDays(
  weeklySchedule.filter((s) => s.openToBeginners).map((s) => s.day.slice(0, 3)),
  "or",
);
