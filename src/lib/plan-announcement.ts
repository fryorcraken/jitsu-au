// The rules behind "Email all members about this plan".
//
// A manager ticks a box beside Save on /manager/membership-plans (or an agent
// passes `announce: true` to `save_membership_plan`), and every member hears
// about the plan at once. This module decides WHO hears, WHAT it says, and how
// the screen reads back "Announced on 3 Nov to 84 people". The I/O lives in
// `plan-announcement.server.ts`; everything here is pure so it can be tested
// without a database, the same split as `notifications.ts`.
//
// Three decisions shape it, and each is deliberate:
//
// 1. **The audience is one function, `announcementAudience`.** "All members"
//    today means every person whose account is active, which is to say a
//    manager has approved one of their waivers. When the club can mark somebody
//    as having left, they come out of this email, and that change belongs in
//    that function and nowhere else.
// 2. **One inbox, one email.** A child has no mailbox (`household.ts`), so a
//    family is one email to the parent naming the children it is for, never
//    one per child. The notification rows follow the same unit: one per inbox,
//    written on the contact person, so the count on the manager's screen is the
//    number of emails that went out.
// 3. **An announcement is its own subject, not the plan.** A plan may be
//    announced again (after a price change, say), so the row's `subject_id` is
//    the announcement's own id and the plan is named by the `href`, which is
//    also the link the email opens. Re-sending the SAME announcement (a retried
//    save, a double click) collides on the unique index and emails nobody twice.
import { formatDateOnlyWords } from "@/lib/dates";
import { contactUserIdFor, type HouseholdLink } from "@/lib/household";
import { formatCents, greetingName, type PersonNameParts } from "@/lib/validation";
import type { MembershipPlanKind } from "@/lib/validation";

/** The notification kind, and the subject type it is stored under. */
export const PLAN_ANNOUNCEMENT_KIND = "membership_plan_open" as const;
export const PLAN_ANNOUNCEMENT_SUBJECT = "membership_plan_announcement" as const;

/**
 * Where the email and the in-app row send somebody: that plan, on /membership.
 *
 * A query parameter, not a `#fragment`: a member who opens the email signed out
 * is sent through `/auth`, which carries the path and query back and drops a
 * fragment. The page scrolls to the plan once its cards have loaded.
 */
export function planAnnouncementHref(planId: string): string {
  return `/membership?plan=${planId.toLowerCase()}`;
}

/** The plan an announcement row is about, read back off its `href`. */
export function planIdFromAnnouncementHref(href: string): string | null {
  const m = /^\/membership\?plan=([0-9a-f-]{36})$/.exec(href);
  return m ? m[1] : null;
}

// ---- who hears about it ----

/** A person as the audience reads them: their household link and their name. */
export type AudiencePerson = HouseholdLink & PersonNameParts;

/** One email: the inbox it goes to, and the people in it the plan is for. */
export type AnnouncementInbox = {
  /** The person whose mailbox it is, and whose row the notification is. */
  contactUserId: string;
  /** Whether the reader is themselves an active member, not only a parent. */
  includesSelf: boolean;
  /** The active members on their account, by greeting name, in name order. */
  dependants: { userId: string; name: string }[];
};

/**
 * Who "all members" is, as inboxes.
 *
 * Everybody the club holds a person record for whose account is ACTIVE, which
 * is to say a manager has approved one of their waivers, resolved to the inbox
 * the club writes to about them and de-duplicated. That leaves out:
 *
 * - **leads**, who filled in the interest form and have no person record, so
 *   never reach this list at all;
 * - **applicants**, whose waiver is still waiting: their login is locked, and
 *   the email's link goes to a signed-in page they cannot open.
 *
 * A parent who does not train themselves is still the inbox for their active
 * children, and their email names only the children. When "left the club"
 * exists, it is one more condition on `active` below.
 */
export function announcementAudience(input: {
  people: AudiencePerson[];
  /** Every person a manager has approved a waiver for. */
  approvedUserIds: Iterable<string>;
}): AnnouncementInbox[] {
  const approved = new Set([...input.approvedUserIds].map((id) => id.toLowerCase()));
  const byInbox = new Map<string, AnnouncementInbox>();

  for (const person of input.people) {
    const id = person.user_id.toLowerCase();
    const active = approved.has(id);
    if (!active) continue;

    const contactId = contactUserIdFor(person).toLowerCase();
    const inbox = byInbox.get(contactId) ?? {
      contactUserId: contactId,
      includesSelf: false,
      dependants: [],
    };
    if (contactId === id) inbox.includesSelf = true;
    else inbox.dependants.push({ userId: id, name: greetingName(person) || "your child" });
    byInbox.set(contactId, inbox);
  }

  for (const inbox of byInbox.values())
    inbox.dependants.sort((a, b) => a.name.localeCompare(b.name));
  return [...byInbox.values()].sort((a, b) => a.contactUserId.localeCompare(b.contactUserId));
}

// ---- what it says ----

/** The plan fields the announcement reads. */
export type AnnouncedPlan = {
  id: string;
  name: string;
  description: string | null;
  kind: MembershipPlanKind | string;
  public_price_cents: number;
  student_price_cents: number | null;
  starts_on: string | null;
  ends_on: string | null;
  duration_days: number | null;
  session_credits: number | null;
};

/** Both rates where there is a student price: `$445, or $245 for UTS students`. */
export function planPriceText(
  plan: Pick<AnnouncedPlan, "public_price_cents" | "student_price_cents">,
): string {
  const main = formatCents(plan.public_price_cents);
  if (plan.student_price_cents == null || plan.student_price_cents === plan.public_price_cents)
    return main;
  return `${main}, or ${formatCents(plan.student_price_cents)} for UTS students`;
}

/** When it runs, in a member's words, or null when there is nothing to say. */
export function planRunsText(
  plan: Pick<AnnouncedPlan, "starts_on" | "ends_on" | "duration_days" | "session_credits">,
): string | null {
  if (plan.starts_on && plan.ends_on)
    return `${formatDateOnlyWords(plan.starts_on)} to ${formatDateOnlyWords(plan.ends_on)}`;
  if (plan.duration_days) return `${plan.duration_days} days from the day it starts`;
  if (plan.session_credits)
    return plan.session_credits === 1 ? "One class" : `${plan.session_credits} classes`;
  return null;
}

/**
 * Who in this inbox needs yearly insurance to train on this plan, as the email
 * names them: "you", then each child. Empty when nobody does, which includes
 * a plan that never needs cover (the trial, the insurance plan itself) and a
 * club with no insurance plan on sale.
 */
export function uninsuredNames(
  inbox: AnnouncementInbox,
  opts: { insuranceRequired: boolean; coveredUserIds: ReadonlySet<string> },
): string[] {
  if (!opts.insuranceRequired) return [];
  const names: string[] = [];
  if (inbox.includesSelf && !opts.coveredUserIds.has(inbox.contactUserId)) names.push("you");
  for (const d of inbox.dependants) if (!opts.coveredUserIds.has(d.userId)) names.push(d.name);
  return names;
}

/** Whether a plan of this kind is sold with yearly insurance alongside it. */
export function planNeedsInsurance(kind: AnnouncedPlan["kind"]): boolean {
  return kind !== "trial" && kind !== "insurance";
}

/** `a`, `a and b`, `a, b and c`. */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Who the email is for, as one phrase: `you`, `Bea`, `you, Bea and Sam`. */
export function forWhomText(inbox: AnnouncementInbox): string {
  return joinNames([
    ...(inbox.includesSelf ? ["you"] : []),
    ...inbox.dependants.map((d) => d.name),
  ]);
}

/** The stored notification's title. Also the in-app list's headline. */
export function announcementTitle(plan: Pick<AnnouncedPlan, "name">): string {
  return `Membership: ${plan.name}`.slice(0, 200);
}

/**
 * The stored notification's body: what the plan is and costs, and who it is
 * for. This is all the in-app list and the morning summary ever show, so it
 * has to stand on its own if the immediate email never went.
 */
export function announcementBody(plan: AnnouncedPlan, inbox: AnnouncementInbox): string {
  const runs = planRunsText(plan);
  const parts = [runs ? `${runs}.` : null, `${planPriceText(plan)}.`];
  if (inbox.dependants.length > 0) parts.push(`For ${forWhomText(inbox)}.`);
  return parts.filter(Boolean).join(" ").slice(0, 500);
}

// ---- what the manager sees afterwards ----

/** The last time a plan was announced, as the screen and the agent API report it. */
export type AnnouncementSummary = {
  /** The announcement's id, which is also every row's `subject_id`. */
  announcement_id: string;
  /** When it was sent: the earliest row it wrote. */
  announced_at: string;
  /** How many inboxes it reached, which is how many emails it is. */
  recipients: number;
  /** How many of those have actually been emailed so far. */
  emailed: number;
  /** How many times this plan has been announced in all. */
  times: number;
};

/**
 * Each plan's most recent announcement, read back off the notification rows.
 *
 * Grouped by plan (the `href`) and then by announcement (`subject_id`), so a
 * plan announced twice reports the latest send and says it was the second.
 */
export function announcementSummaries(
  rows: { subject_id: string; href: string; created_at: string; emailed_at: string | null }[],
): Map<string, AnnouncementSummary> {
  const byPlan = new Map<string, Map<string, AnnouncementSummary>>();
  for (const row of rows) {
    const planId = planIdFromAnnouncementHref(row.href);
    if (!planId) continue;
    const sends = byPlan.get(planId) ?? new Map<string, AnnouncementSummary>();
    const s = sends.get(row.subject_id) ?? {
      announcement_id: row.subject_id,
      announced_at: row.created_at,
      recipients: 0,
      emailed: 0,
      times: 0,
    };
    s.recipients += 1;
    if (row.emailed_at) s.emailed += 1;
    if (row.created_at < s.announced_at) s.announced_at = row.created_at;
    sends.set(row.subject_id, s);
    byPlan.set(planId, sends);
  }

  const out = new Map<string, AnnouncementSummary>();
  for (const [planId, sends] of byPlan) {
    const all = [...sends.values()].sort((a, b) => a.announced_at.localeCompare(b.announced_at));
    const latest = all[all.length - 1];
    out.set(planId, { ...latest, times: all.length });
  }
  return out;
}

/** "Announced on 3 Nov to 84 people", for the plan's card. */
export function announcedLine(summary: AnnouncementSummary, clubDate: string): string {
  const people = summary.recipients === 1 ? "1 person" : `${summary.recipients} people`;
  const again = summary.times > 1 ? "Last announced" : "Announced";
  const line = `${again} on ${formatDateOnlyWords(clubDate, { year: false })} to ${people}`;
  const waiting = summary.recipients - summary.emailed;
  if (waiting <= 0) return `${line}.`;
  return `${line}. ${waiting} of those emails ${waiting === 1 ? "has" : "have"} not gone out yet, and will go with the next morning's summary.`;
}

/** The hard stop's question, with the real number in it. */
export function announceConfirmTitle(
  planName: string,
  inboxes: number,
  opts: { saving: boolean } = { saving: true },
): string {
  const people = inboxes === 1 ? "1 person" : `${inboxes} people`;
  return `${opts.saving ? "Save and email" : "Email"} ${people} about ${planName}?`;
}
