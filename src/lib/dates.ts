// Date formatting for the manager and member screens.
//
// Shared for the same reason the status colours are: two copies of `fmtDate`
// had already drifted, so a missing date read "none" on the user list and "—"
// on the person page. "—" wins because it is what every other table in the app
// puts in an empty cell.
//
// Keep this module free of side effects and server-only imports so it stays
// unit-testable, mirroring `validation.ts`.

/** What an empty cell shows. */
export const EMPTY = "—";

/** A timestamp as a date: `29/07/2026`. */
export function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString("en-AU") : EMPTY;
}

/** A timestamp with its time of day: `29/07/2026, 2:57:18 pm`. */
export function formatDateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString("en-AU") : EMPTY;
}

/**
 * A `DATE` column, which arrives as `YYYY-MM-DD`. `new Date` would read that as
 * UTC midnight and shift it a day back for anyone in a negative-offset
 * timezone, so format the parts directly: a birth date has no timezone.
 */
export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return parts ? `${parts[3]}/${parts[2]}/${parts[1]}` : value;
}

/**
 * "14:32", "yesterday at 14:32", "12 Aug at 14:32".
 *
 * A bare timestamp is the wrong answer for the common case, which is a draft
 * from ten minutes ago: the useful thing to know is whether this is the work
 * they just lost or something much older they had forgotten about.
 */
export function describeWhen(savedAt: number, now = Date.now()): string {
  const then = new Date(savedAt);
  const time = then.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (savedAt >= startOfToday.getTime()) return time;
  const startOfYesterday = startOfToday.getTime() - 24 * 60 * 60_000;
  if (savedAt >= startOfYesterday) return `yesterday at ${time}`;
  const date = then.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  return `${date} at ${time}`;
}
