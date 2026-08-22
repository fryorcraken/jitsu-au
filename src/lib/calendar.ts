// Pure calendar helpers: recurrence enumeration and timezone-correct instants.
//
// Side-effect free and server-import free (no supabase, no process.env) so the
// occurrence math is unit-testable. The club trains in Sydney, so a recurring
// series stores a LOCAL wall-clock time (e.g. Monday 18:00) and we materialize
// absolute UTC instants for each date, handling DST via the Intl API (no
// timezone dependency).

import { VENUE_ADDRESS, VENUE_NAME } from "./venue";

export const CLUB_TIME_ZONE = "Australia/Sydney";

/** JS weekday indices (Date.getUTCDay / getDay): 0 = Sunday .. 6 = Saturday. */
export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function parseDateOnly(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

/**
 * The calendar dates (YYYY-MM-DD, inclusive) between `fromISO` and `toISO` that
 * fall on `weekday` (0=Sun..6=Sat). Enumerated on the date grid in UTC so it is
 * free of any timezone/DST ambiguity — these are wall-clock calendar days.
 */
export function weeklyOccurrenceDates(weekday: number, fromISO: string, toISO: string): string[] {
  const from = parseDateOnly(fromISO);
  const to = parseDateOnly(toISO);
  const start = Date.UTC(from.y, from.m - 1, from.d);
  const end = Date.UTC(to.y, to.m - 1, to.d);
  if (end < start) return [];
  const out: string[] = [];
  const DAY = 86_400_000;
  // Advance to the first matching weekday at or after `start`.
  let cursor = start;
  const startDow = new Date(cursor).getUTCDay();
  const delta = (weekday - startDow + 7) % 7;
  cursor += delta * DAY;
  for (; cursor <= end; cursor += 7 * DAY) {
    const d = new Date(cursor);
    out.push(
      `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
    );
  }
  return out;
}

/**
 * Minutes `timeZone` is ahead of UTC at the given absolute instant (e.g. +600
 * for AEST, +660 for AEDT). Uses Intl so DST is correct without a tz library.
 */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  const asIfUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return Math.round((asIfUtc - instant.getTime()) / 60000);
}

/**
 * The calendar date (YYYY-MM-DD) that `instant` falls on in `timeZone`.
 *
 * Needed wherever "today" means today at the club rather than today in UTC: at
 * 09:00 in Sydney the UTC date is still yesterday, so `toISOString().slice(0,10)`
 * puts every morning class on the wrong day.
 */
export function clubLocalDate(instant: Date, timeZone: string = CLUB_TIME_ZONE): string {
  const shifted = new Date(instant.getTime() + tzOffsetMinutes(instant, timeZone) * 60000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The absolute instant whose local time in `timeZone` is `dateStr`T`timeStr`
 * (e.g. "2026-01-26" + "18:00" in Australia/Sydney). Resolves the offset at the
 * candidate instant and corrects once for DST boundaries.
 */
export function zonedWallTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const { y, m, d } = parseDateOnly(dateStr);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guessUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offset1 = tzOffsetMinutes(new Date(guessUtc), timeZone);
  const candidate = guessUtc - offset1 * 60000;
  const offset2 = tzOffsetMinutes(new Date(candidate), timeZone);
  // If the offset changed (spring-forward / fall-back), re-resolve once.
  const finalMs = offset2 === offset1 ? candidate : guessUtc - offset2 * 60000;
  return new Date(finalMs);
}

/** A new Date `minutes` after `d` (never mutates `d`). */
export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60000);
}

/** How long a one-off entry runs unless the manager says otherwise. */
export const DEFAULT_EVENT_DURATION_MINUTES = 60;

/**
 * Where the club trains, pre-filled on a new calendar entry. Built from the
 * shared venue constants, which now carry the building and street number this
 * line used to restate on its own. It has to get someone from the street to the
 * mats, and so does every other surface, so there is one address for all of them.
 */
export const DEFAULT_EVENT_LOCATION = `${VENUE_NAME}, ${VENUE_ADDRESS}`;

/**
 * Read a `datetime-local` value ("YYYY-MM-DDTHH:MM", seconds optional) as plain
 * wall-clock fields. Anchored to UTC so the arithmetic below stays wall-clock:
 * these strings are what the manager sees in the picker, and the club timezone
 * is only applied later, on submit.
 */
function parseLocalDateTime(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm)));
}

function formatLocalDateTime(d: Date): string {
  return d.toISOString().slice(0, 16);
}

/**
 * The "Ends" a manager should see once they have picked a "Starts": an hour
 * later, which is the same day for anything but a late-night entry.
 *
 * `endEdited` says whether the manager has typed in the Ends field themselves.
 * Their own end is kept and the start moves freely under it, up to the point
 * where it would overtake the end and make the entry backwards. An end this
 * function filled in is not theirs, so it follows every correction to the start
 * rather than quietly leaving a nine-hour entry behind when 18:00 becomes 09:00.
 *
 * The hour is added in wall-clock terms, matching what the picker shows. On the
 * one Sydney morning a year when 02:00-02:59 does not exist, the club-time
 * conversion on submit collapses both ends onto the same instant; a manager
 * scheduling into that hour has to set the end themselves.
 */
export function defaultEndForStart(
  startLocal: string,
  currentEndLocal: string,
  endEdited: boolean,
): string {
  const start = parseLocalDateTime(startLocal);
  if (!start) return currentEndLocal;
  const currentEnd = parseLocalDateTime(currentEndLocal);
  if (endEdited && currentEnd && currentEnd.getTime() > start.getTime()) return currentEndLocal;
  return formatLocalDateTime(addMinutes(start, DEFAULT_EVENT_DURATION_MINUTES));
}

export type SeriesSpec = {
  weekday: number;
  start_time: string; // "HH:MM" local
  duration_minutes: number;
  starts_on: string; // "YYYY-MM-DD"
  ends_on: string | null;
};

export type GeneratedOccurrence = { starts_at: string; ends_at: string };

/**
 * The occurrences that don't already exist, comparing by absolute instant rather
 * than by string so differing ISO spellings of the same moment
 * ("2026-07-06T08:00:00+00:00" vs "...Z") don't produce a duplicate date.
 * Pure so the de-duplication that protects the calendar from double entries is
 * unit-testable without a database.
 */
export function diffOccurrences(
  existing: { starts_at: string }[],
  occurrences: GeneratedOccurrence[],
): GeneratedOccurrence[] {
  const present = new Set(existing.map((r) => new Date(r.starts_at).getTime()));
  return occurrences.filter((o) => !present.has(new Date(o.starts_at).getTime()));
}

/**
 * Materialize a series into absolute UTC instants for every occurrence in
 * [fromISO, toISO], clamped to the series' own start/end dates. Returns ISO
 * strings ready to insert as `calendar_events.starts_at/ends_at`.
 */
export function generateOccurrences(
  series: SeriesSpec,
  fromISO: string,
  toISO: string,
  timeZone: string = CLUB_TIME_ZONE,
): GeneratedOccurrence[] {
  const windowStart = series.starts_on > fromISO ? series.starts_on : fromISO;
  const windowEnd = series.ends_on && series.ends_on < toISO ? series.ends_on : toISO;
  const dates = weeklyOccurrenceDates(series.weekday, windowStart, windowEnd);
  return dates.map((date) => {
    const start = zonedWallTimeToUtc(date, series.start_time, timeZone);
    const end = addMinutes(start, series.duration_minutes);
    return { starts_at: start.toISOString(), ends_at: end.toISOString() };
  });
}
