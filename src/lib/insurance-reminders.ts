// When yearly insurance ends: who is owed which reminder today, and what it says.
//
// A yearly insurance membership runs `duration_days` from the day it starts,
// and until this nothing told anybody when it ran out: check-in never looks at
// it (insurance never covers a class, docs/check-in.md) and there is no expiry
// sweep, so an ended year of cover sat `active` and silent. The daily job now
// sends two reminders per membership, 14 days before it ends and on the day it
// ends. docs/memberships.md, "When yearly insurance ends", is the spec.
//
// Pure and server-import free, like `validation.ts`: the daily run, the manager
// screens, the attention item and the agent API all ask the same functions
// here, so the email, the screen and the API cannot disagree about who is due.
//
// Three decisions live here and nowhere else:
//
// - **The audience is `insuranceRemindersDue`, in one function.** When "left
//   the club" exists, the people who left drop out here and every surface
//   follows.
// - **Windows, not exact days.** The job runs once a day and can miss a
//   morning, so "ending soon" is any day in the 14 before the end and "ended"
//   is the end day or up to 3 days after. Each is sent once per membership,
//   which the unique index on notifications enforces, so a wide window never
//   means a second email.
// - **The 3-day cap on "ended" is what keeps the first deploy quiet.** Without
//   it, the first run would email everybody whose insurance ran out at any
//   point in the club's history.
import { clubLocalDate, CLUB_TIME_ZONE } from "@/lib/calendar";
import { calendarDaysBetween } from "@/lib/validation";
import { subjectVoice } from "@/lib/subject-voice";

/** How many club days before the end the first reminder goes out. */
export const INSURANCE_ENDING_SOON_DAYS = 14;

/**
 * How many club days after the end an "ended" reminder may still go out, for a
 * morning the job missed. Older than this and it is history, not news.
 */
export const INSURANCE_ENDED_CAP_DAYS = 3;

/** The two notification kinds. Both are unswitchable (`notifications.ts`). */
export const insuranceReminderKinds = ["insurance_ending_soon", "insurance_ended"] as const;
export type InsuranceReminderKind = (typeof insuranceReminderKinds)[number];

/** An insurance membership, as much of it as the rules read. */
export type InsuranceCover = {
  id: string;
  user_id: string | null;
  status: string;
  ends_at: string | null;
};

/** One reminder owed today. */
export type DueInsuranceReminder = {
  membershipId: string;
  userId: string;
  kind: InsuranceReminderKind;
  /** The club date the cover ends on (YYYY-MM-DD). */
  endDay: string;
  /** Club days from today to `endDay`: 14 down to 1 ending soon, 0 to -3 ended. */
  daysLeft: number;
};

/** The club date a membership's cover ends on, the date the screens print. */
export function coverEndDay(endsAt: string): string {
  return clubLocalDate(new Date(endsAt), CLUB_TIME_ZONE);
}

/**
 * Whether somebody already holds cover that runs past this membership's end:
 * another insurance membership of theirs, active, ending later. Paid or not,
 * since cover is about dates. Reminding them to renew what they renewed would
 * be wrong, and it would read as a mistake on the club's part.
 */
function alreadyRenewed(m: InsuranceCover, theirs: readonly InsuranceCover[]): boolean {
  const end = new Date(m.ends_at ?? 0).getTime();
  return theirs.some(
    (o) =>
      o.id !== m.id &&
      (o.status === "active" || o.status === "pending") &&
      o.ends_at != null &&
      new Date(o.ends_at).getTime() > end,
  );
}

/**
 * Every insurance reminder owed today, across the club.
 *
 * `covers` must be every insurance membership that could matter: those that
 * end inside the windows, and anything the same people hold that ends later
 * (the renewal check). The caller selects by the plan's `kind = 'insurance'`,
 * never by the `insurance_yearly` code.
 *
 * Nothing here knows whether a reminder was already sent. That is the unique
 * index's job, and keeping it out is what makes the same answer usable by a
 * screen ("ends within 14 days") as by the sender ("owed an email").
 */
export function insuranceRemindersDue(
  covers: readonly InsuranceCover[],
  now: Date,
): DueInsuranceReminder[] {
  const today = clubLocalDate(now, CLUB_TIME_ZONE);
  const byUser = new Map<string, InsuranceCover[]>();
  for (const c of covers) {
    if (!c.user_id) continue;
    const list = byUser.get(c.user_id) ?? [];
    list.push(c);
    byUser.set(c.user_id, list);
  }

  const due: DueInsuranceReminder[] = [];
  for (const c of covers) {
    // A cancelled membership was ended on purpose by a manager, so it is owed
    // nothing. One with no end date is not a year of cover at all.
    if (!c.user_id || !c.ends_at || c.status === "cancelled") continue;
    const endDay = coverEndDay(c.ends_at);
    const daysLeft = calendarDaysBetween(today, endDay);
    const kind: InsuranceReminderKind | null =
      daysLeft > 0 && daysLeft <= INSURANCE_ENDING_SOON_DAYS
        ? "insurance_ending_soon"
        : daysLeft <= 0 && daysLeft >= -INSURANCE_ENDED_CAP_DAYS
          ? "insurance_ended"
          : null;
    if (!kind) continue;
    if (alreadyRenewed(c, byUser.get(c.user_id) ?? [])) continue;
    due.push({ membershipId: c.id, userId: c.user_id, kind, endDay, daysLeft });
  }
  return due;
}

/** `2027-03-12` as "12 March": the end is never far enough away to need a year. */
export function reminderDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** "ends on 12 March", "ended today", "ended on 12 March". */
function endPhrase(kind: InsuranceReminderKind, endDay: string, today: string): string {
  if (kind === "insurance_ending_soon") return `ends on ${reminderDate(endDay)}`;
  return endDay === today ? "ended today" : `ended on ${reminderDate(endDay)}`;
}

/**
 * The title frozen onto one person's notification row. Dated rather than
 * "today", because a row is read later than it is written.
 *
 * `name` is the person's first or preferred name when the row is about
 * somebody other than the account holder (a child), or null for their own.
 */
export function insuranceReminderTitle(
  kind: InsuranceReminderKind,
  endDay: string,
  name: string | null,
): string {
  const verb = kind === "insurance_ending_soon" ? "ends" : "ended";
  return `${subjectVoice(name).Whose} club insurance ${verb} on ${reminderDate(endDay)}`;
}

/** Where renewing happens: `/membership`, opened on the right person. */
export function insuranceRenewHref(childUserId: string | null): string {
  return childUserId ? `/membership?for=${encodeURIComponent(childUserId)}` : "/membership";
}

/** One person an email is about. `name` is null for the person reading it. */
export type ReminderPerson = { userId: string; name: string | null };

/** "you", "Bea", "you and Bea", "Bea, Cy and Di". */
function whoList(people: readonly ReminderPerson[]): string {
  const names = people.map((p) => subjectVoice(p.name).who);
  if (names.length <= 1) return names[0] ?? "you";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What one reminder email says. */
export type InsuranceReminderCopy = {
  subject: string;
  heading: string;
  body: string;
  /** Site-relative link to where they renew. */
  renewHref: string;
};

/**
 * One email to one inbox, about everybody in it whose cover ends on the same
 * day with the same reminder. A parent with two children ending on 12 March
 * gets one email naming both, never two.
 */
export function insuranceReminderCopy(input: {
  kind: InsuranceReminderKind;
  endDay: string;
  today: string;
  people: readonly ReminderPerson[];
}): InsuranceReminderCopy {
  const { kind, endDay, today, people } = input;
  const phrase = endPhrase(kind, endDay, today);
  const subject =
    people.length === 1
      ? `${subjectVoice(people[0].name).Whose} club insurance ${phrase}`
      : `Club insurance for ${whoList(people)} ${phrase}`;
  const others = people.filter((p) => p.name !== null);
  const onlySelf = others.length === 0;
  const need =
    kind === "insurance_ending_soon"
      ? onlySelf
        ? "You need it to train with us, so renew before then."
        : "It is needed to train with us, so renew before then."
      : onlySelf
        ? "You need it to train with us, so renew before your next class."
        : "It is needed to train with us, so renew before the next class.";
  const renewHref = insuranceRenewHref(
    people.length === 1 && people[0].name !== null ? people[0].userId : null,
  );
  return {
    subject,
    heading: subject,
    body: `${need} Open the Membership page and choose Yearly insurance. It is also offered when you pick a training period.`,
    renewHref,
  };
}

/** What a manager screen and the agent API say about one insurance membership. */
export type InsuranceReminderState = {
  /** True while its "ending soon" reminder is owed: inside 14 days, not renewed. */
  ends_within_14_days: boolean;
  /** The latest reminder actually emailed about it, if any. */
  last_sent: { kind: InsuranceReminderKind; sent_at: string } | null;
};

/**
 * The line a manager reads on an insurance membership's row, or null when
 * there is nothing to say. "Sent" is only ever said about an email that went
 * out: a reminder that stopped being owed is withdrawn, never stamped.
 */
export function insuranceReminderLabel(state: InsuranceReminderState | null): string | null {
  if (!state) return null;
  if (state.last_sent) {
    const when = new Date(state.last_sent.sent_at).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      timeZone: CLUB_TIME_ZONE,
    });
    return state.last_sent.kind === "insurance_ending_soon"
      ? `14-day reminder sent ${when}`
      : `Ended reminder sent ${when}`;
  }
  return state.ends_within_14_days ? "Reminder not sent yet" : null;
}
