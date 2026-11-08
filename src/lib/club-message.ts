// The rules behind club messages: a manager writes one email on
// /manager/messages (or an agent calls `send_club_message`) and it goes to the
// people they ticked. Product rules: docs/club-messages.md.
//
// Pure and server-import free, like `plan-announcement.ts`, so every rule here
// is tested without a database. The I/O is `club-message.server.ts`.
//
// What shapes it:
//
// 1. **Today there is one kind, the club notice.** Closures, time changes, a
//    venue move: facts only. Under the Spam Act that is a message of factual
//    information, which needs no consent and no unsubscribe, so it reaches
//    members whatever their switches say (it is in
//    `UNSWITCHABLE_NOTIFICATION_KINDS`). Promotions are a second kind that
//    has not shipped; they will need consent from leads and a switch for
//    members.
// 2. **People are picked by group, leads one by one.** A person's group is
//    their funnel phase (`deriveLifecycleStatus`), the same one the users page
//    shows, so the count on the Messages screen agrees with what a manager
//    sees there. Leads have no person record, so they are a list of
//    registrations with a tick box each, the last 90 days ticked to start with.
// 3. **One inbox, one email.** A family is one email to the parent, the same
//    fold `plan-announcement.ts` makes, so the count is the number of emails.
// 4. **Nobody who has left gets one.** An archived person is never in the
//    audience. A notice goes out through the club's email service (Lovable
//    Emails), which adds its own unsubscribe line to every email and refuses
//    to deliver to anyone who used it, so there is no separate "stop" list of
//    ours to consult. Lovable does not allow a second one alongside it.
import { z } from "zod";

import { contactUserIdFor, type HouseholdLink } from "@/lib/household";
import { normalizeEmail, type LifecycleStatus } from "@/lib/validation";

/** The notification kind the members' copy is stored under, and its subject type. */
export const CLUB_NOTICE_KIND = "club_notice" as const;
export const CLUB_MESSAGE_SUBJECT = "club_message" as const;

/** The kinds of message there are. Promotions join this list when they ship. */
export const clubMessageKinds = ["notice"] as const;
export type ClubMessageKind = (typeof clubMessageKinds)[number];

/** Leads who registered this recently are ticked to start with. */
export const LEAD_PRESELECT_DAYS = 90;

/** The groups of people a manager can tick. Leads are picked separately. */
export const clubMessageGroups = ["members", "visitors", "applicants"] as const;
export type ClubMessageGroup = (typeof clubMessageGroups)[number];

/** What each group is called on the screen and in the history. */
export const CLUB_MESSAGE_GROUP_LABELS: Record<ClubMessageGroup, string> = {
  members: "Members",
  visitors: "Visitors and lapsed members",
  applicants: "Applicants",
};

/** One line under each group, so a manager knows who is in it. */
export const CLUB_MESSAGE_GROUP_HINTS: Record<ClubMessageGroup, string> = {
  members: "Paying for training now.",
  visitors: "Waiver approved, not paying for training now.",
  applicants: "Signed a waiver that is still waiting for approval.",
};

/**
 * Which group a person is in, or null for nobody a group reaches.
 *
 * Lapsed sits with visitors: both have an open account and no paid training
 * right now, and a closure notice matters to both the same way.
 */
export function groupForStatus(status: LifecycleStatus): ClubMessageGroup | null {
  switch (status) {
    case "member":
      return "members";
    case "visitor":
    case "lapsed":
      return "visitors";
    case "applicant":
      return "applicants";
    case "lead":
      return null;
  }
}

/** A person as the audience reads them. */
export type MessagePerson = HouseholdLink & {
  /** What to call them, for "this is for Bea". */
  name: string;
  lifecycle_status: LifecycleStatus;
  /** Set when a manager has marked them as having left the club. */
  archived: boolean;
};

/** One email to one inbox. */
export type MessageInbox = {
  /** The person whose mailbox it is, and whose row the notification is. */
  contactUserId: string;
  /** Whether the reader is themselves in a ticked group, not only a parent. */
  includesSelf: boolean;
  /** The people on their account it is for, by name, in name order. */
  dependants: { userId: string; name: string }[];
};

/**
 * The people a message reaches, as inboxes.
 *
 * Everybody in a ticked group who has not left the club, folded to the inbox
 * the club writes to about them. A parent who is in no ticked group still gets
 * it for a child who is, and their email names the child. An inbox whose
 * owner has left the club gets nothing at all.
 */
export function messageAudience(input: {
  people: MessagePerson[];
  groups: Iterable<ClubMessageGroup>;
}): MessageInbox[] {
  const groups = new Set(input.groups);
  const byId = new Map(input.people.map((p) => [p.user_id.toLowerCase(), p]));
  const byInbox = new Map<string, MessageInbox>();

  for (const person of input.people) {
    if (person.archived) continue;
    const group = groupForStatus(person.lifecycle_status);
    if (!group || !groups.has(group)) continue;

    const id = person.user_id.toLowerCase();
    const contactId = contactUserIdFor(person).toLowerCase();
    if (byId.get(contactId)?.archived) continue;

    const inbox = byInbox.get(contactId) ?? {
      contactUserId: contactId,
      includesSelf: false,
      dependants: [],
    };
    if (contactId === id) inbox.includesSelf = true;
    else inbox.dependants.push({ userId: id, name: person.name || "your child" });
    byInbox.set(contactId, inbox);
  }

  for (const inbox of byInbox.values())
    inbox.dependants.sort((a, b) => a.name.localeCompare(b.name));
  return [...byInbox.values()].sort((a, b) => a.contactUserId.localeCompare(b.contactUserId));
}

/** An interest registration, as the lead list reads it. */
export type LeadRegistration = {
  id: string;
  name: string;
  email: string;
  created_at: string;
  promotion_consent: boolean;
};

/** One lead a manager can tick: the address, and the registration that stands for it. */
export type LeadCandidate = {
  /** The newest registration for this address. Its row is what a send records. */
  registration_id: string;
  name: string;
  email: string;
  /** When they last filled in the interest form. */
  registered_at: string;
  /** Whether any of their registrations ticked "keep me posted". */
  promotion_consent: boolean;
  /** Ticked to start with: they registered in the last `LEAD_PRESELECT_DAYS`. */
  preselected: boolean;
};

/**
 * Every lead a message could go to, newest first.
 *
 * The same dedupe the users page makes (`aggregateClubUsers`): one row per
 * address, the newest registration standing for it, and an address that now
 * belongs to a person is left out, because they get the message as that
 * person if their group is ticked.
 */
export function leadCandidates(input: {
  registrations: LeadRegistration[];
  /** Every address the club holds a person record for. */
  personEmails: Iterable<string>;
  now: Date;
}): LeadCandidate[] {
  const people = new Set([...input.personEmails].map(normalizeEmail));
  const cutoff = new Date(input.now.getTime() - LEAD_PRESELECT_DAYS * 86_400_000).toISOString();

  const byEmail = new Map<string, LeadRegistration[]>();
  for (const r of input.registrations) {
    const email = normalizeEmail(r.email);
    if (!email || people.has(email)) continue;
    const list = byEmail.get(email) ?? [];
    list.push(r);
    byEmail.set(email, list);
  }

  const out: LeadCandidate[] = [];
  for (const list of byEmail.values()) {
    const latest = list.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    out.push({
      registration_id: latest.id,
      name: latest.name.trim() || latest.email,
      email: latest.email.trim(),
      registered_at: latest.created_at,
      promotion_consent: list.some((r) => r.promotion_consent),
      preselected: latest.created_at >= cutoff,
    });
  }
  return out.sort((a, b) => b.registered_at.localeCompare(a.registered_at));
}

/** Where the members' copy of a message is read on the site. */
export function clubMessageHref(messageId: string): string {
  return `/messages/${messageId.toLowerCase()}`;
}

/**
 * The message reduced to one plain line, for the in-app list and the morning
 * summary, which show a short body rather than the whole email.
 *
 * Markdown punctuation is dropped and a link keeps its words. Cut at a word
 * boundary, like `commentPreview`.
 */
export function plainExcerpt(markdown: string, max = 300): string {
  const flat = markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

/** "212 people", "1 person". */
export function peopleCount(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

/** The hard stop before a send, with the real number in it. */
export function sendConfirmTitle(subject: string, emails: number): string {
  return `Email ${peopleCount(emails)} about "${subject}"?`;
}

/** What a message reached, as the screen and the agent API report it. */
export type ClubMessageProgress = {
  /** Emails this message is: one per inbox, plus one per lead. */
  recipients: number;
  /** How many of those have gone, this call or an earlier one. */
  emailed: number;
  /** How many are still to go. Above zero, "Send the rest now" or the morning run sends them. */
  pending: number;
};

/** Add up the two kinds of recipient row a message writes. */
export function messageProgress(
  rows: { emailed_at: string | null }[],
  leadRows: { emailed_at: string | null }[],
): ClubMessageProgress {
  const all = [...rows, ...leadRows];
  const emailed = all.filter((r) => r.emailed_at).length;
  return { recipients: all.length, emailed, pending: all.length - emailed };
}

// ---- input schemas ----
//
// Here rather than in `validation.ts`, which this module imports from: a
// schema there built from `clubMessageGroups` would need this module loaded
// first, and the two would import each other. Shared by the screen's server
// functions and the manager agent API, so both refuse the same things.

/** A subject goes into the email's subject line, so it is one line. */
const subjectLine = z
  .string()
  .trim()
  .min(1, "Give the message a subject.")
  .max(200)
  .regex(/^[^\r\n]*$/, "The subject has to fit on one line.");

/** What the manager wrote. */
export const clubMessageDraftSchema = z.object({
  kind: z.enum(clubMessageKinds),
  subject: subjectLine,
  body: z.string().trim().min(1, "Write the message.").max(20000),
});

/** Who it goes to. At least one group or one lead. */
export const clubMessageAudienceSchema = z.object({
  groups: z.array(z.enum(clubMessageGroups)).max(clubMessageGroups.length),
  lead_ids: z.array(z.string().uuid()).max(5000),
});

export const sendClubMessageSchema = clubMessageDraftSchema
  .merge(clubMessageAudienceSchema)
  .extend({ message_id: z.string().uuid() })
  .refine((d) => d.groups.length > 0 || d.lead_ids.length > 0, {
    message: "Tick at least one group or one lead.",
    path: ["groups"],
  });

export const sendClubMessageTestSchema = clubMessageDraftSchema.extend({
  client_submission_id: z.string().uuid(),
});
