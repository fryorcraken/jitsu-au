// Dependency-free iCalendar (RFC 5545) builder.
//
// Pure and side-effect free (no supabase, no process.env) so it is unit-testable
// and runs in Workers/Node/jsdom. Used by the per-member calendar feed route and
// (later) by calendar-invite emails. There is no third-party `ics` dependency;
// the format we emit is small and well specified.

export type IcsMethod = "PUBLISH" | "REQUEST" | "CANCEL";

export type IcsEvent = {
  /** Globally stable identifier, e.g. `<eventId>@jitsu.au`. */
  uid: string;
  /** Absolute start instant. For all-day events only the date part is used. */
  start: Date;
  /** Absolute end instant. */
  end: Date;
  allDay?: boolean;
  summary: string;
  description?: string;
  location?: string;
  /** Emit `STATUS:CANCELLED` (a cancelled occurrence the subscriber should drop). */
  cancelled?: boolean;
  /** Bumped when an event changes so clients replace the prior copy. */
  sequence?: number;
};

/** Escape a text value per RFC 5545 §3.3.11 (backslash, comma, semicolon, newline). */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/**
 * Fold a content line to <=75 OCTETS with CRLF + single-space continuation.
 *
 * RFC 5545 counts octets, not characters, so this measures UTF-8 length: a
 * Japanese class title or an accented instructor name is multi-byte and would
 * otherwise overflow the limit. Chunking also stops on whole code points, so a
 * split never lands inside a surrogate pair and mangles an emoji.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const parts: string[] = [];
  // First line may use 75 octets; continuations lose one to the leading space.
  let limit = 75;
  let current = "";
  let used = 0;
  // Iterate code points (not UTF-16 units) so surrogate pairs stay intact.
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (used + size > limit) {
      parts.push(current);
      current = "";
      used = 0;
      limit = 74;
    }
    current += char;
    used += size;
  }
  if (current) parts.push(current);
  return parts.map((part, i) => (i === 0 ? part : " " + part)).join("\r\n");
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** UTC date-time value, e.g. `20260125T093000Z`. */
export function formatUtcStamp(d: Date): string {
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** UTC date value (for all-day events), e.g. `20260125`. */
export function formatUtcDate(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** The {y,m,d} an instant falls on in `timeZone` (UTC when omitted). */
function datePartsInZone(d: Date, timeZone?: string): { y: number; m: number; d: number } {
  if (!timeZone) return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/**
 * DATE value (all-day events) for the calendar day an instant falls on in
 * `timeZone`. A Sydney all-day event on 2026-08-01 is stored as
 * 2026-07-31T14:00:00Z, so reading the UTC date would land it a day early.
 * `addDays` shifts the result, which DTEND needs (see below).
 */
export function formatDateInZone(d: Date, timeZone?: string, addDays = 0): string {
  const { y, m, d: day } = datePartsInZone(d, timeZone);
  const shifted = new Date(Date.UTC(y, m - 1, day + addDays));
  return `${pad(shifted.getUTCFullYear(), 4)}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}`;
}

/** The VEVENT lines for one event (unfolded content lines). */
export function veventLines(ev: IcsEvent, dtstamp: Date, timeZone?: string): string[] {
  const lines: string[] = ["BEGIN:VEVENT", `UID:${ev.uid}`, `DTSTAMP:${formatUtcStamp(dtstamp)}`];
  if (ev.allDay) {
    // A DATE-valued DTEND is EXCLUSIVE (RFC 5545 3.6.1), so a single-day event
    // ends on the FOLLOWING date. Emitting the same date gives DTEND <= DTSTART,
    // which clients drop or render as zero-length.
    lines.push(`DTSTART;VALUE=DATE:${formatDateInZone(ev.start, timeZone)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDateInZone(ev.end, timeZone, 1)}`);
  } else {
    lines.push(`DTSTART:${formatUtcStamp(ev.start)}`);
    lines.push(`DTEND:${formatUtcStamp(ev.end)}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(ev.summary)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
  lines.push(`SEQUENCE:${ev.sequence ?? 0}`);
  lines.push(`STATUS:${ev.cancelled ? "CANCELLED" : "CONFIRMED"}`);
  lines.push(`TRANSP:${ev.cancelled ? "TRANSPARENT" : "OPAQUE"}`);
  lines.push("END:VEVENT");
  return lines;
}

export type BuildCalendarOptions = {
  events: IcsEvent[];
  /** Feed default is PUBLISH; REQUEST/CANCEL are for emailed invites. */
  method?: IcsMethod;
  calName?: string;
  prodId?: string;
  /** DTSTAMP for every event; defaults to now. Injectable for deterministic tests. */
  now?: Date;
  /**
   * Timezone whose calendar days define all-day events (e.g. "Australia/Sydney").
   * Timed events are always emitted as absolute UTC and ignore this. Defaults to
   * UTC, which is only right if the club also runs on UTC.
   */
  timeZone?: string;
};

/** Assemble a full VCALENDAR document (CRLF-terminated, folded). */
export function buildCalendar(opts: BuildCalendarOptions): string {
  const dtstamp = opts.now ?? new Date();
  const prodId = opts.prodId ?? "-//UTS Jitsu//Calendar//EN";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    `METHOD:${opts.method ?? "PUBLISH"}`,
  ];
  if (opts.calName) {
    lines.push(`NAME:${escapeIcsText(opts.calName)}`);
    lines.push(`X-WR-CALNAME:${escapeIcsText(opts.calName)}`);
  }
  for (const ev of opts.events) lines.push(...veventLines(ev, dtstamp, opts.timeZone));
  lines.push("END:VCALENDAR");
  // Fold each content line, then join with CRLF as required by the spec.
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
