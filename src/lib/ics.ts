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

/** Fold a content line to <=75 octets with CRLF + single-space continuation. */
export function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  // First chunk 75 chars, continuations 74 (a leading space is added on unfold).
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 0) {
    parts.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  return parts.join("\r\n");
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

/** The VEVENT lines for one event (unfolded content lines). */
export function veventLines(ev: IcsEvent, dtstamp: Date): string[] {
  const lines: string[] = ["BEGIN:VEVENT", `UID:${ev.uid}`, `DTSTAMP:${formatUtcStamp(dtstamp)}`];
  if (ev.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatUtcDate(ev.start)}`);
    lines.push(`DTEND;VALUE=DATE:${formatUtcDate(ev.end)}`);
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
  for (const ev of opts.events) lines.push(...veventLines(ev, dtstamp));
  lines.push("END:VCALENDAR");
  // Fold each content line, then join with CRLF as required by the spec.
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
