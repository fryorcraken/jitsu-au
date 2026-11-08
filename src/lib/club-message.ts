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

/**
 * The groups of people a manager can tick. Leads are picked separately.
 *
 * Visitors and lapsed members are two groups, not one: somebody whose trial is
 * over and who has not joined yet is told something different from somebody
 * who was paying and did not renew.
 */
export const clubMessageGroups = ["members", "visitors", "lapsed", "applicants"] as const;
export type ClubMessageGroup = (typeof clubMessageGroups)[number];

/** What each group is called on the screen and in the history. */
export const CLUB_MESSAGE_GROUP_LABELS: Record<ClubMessageGroup, string> = {
  members: "Members",
  visitors: "Visitors",
  lapsed: "Lapsed members",
  applicants: "Applicants",
};

/** One line under each group, so a manager knows who is in it. */
export const CLUB_MESSAGE_GROUP_HINTS: Record<ClubMessageGroup, string> = {
  members: "Paying for training now.",
  visitors: "Waiver approved, never paid for training. A finished trial, say.",
  lapsed: "Used to pay for training, and their membership ended.",
  applicants: "Signed a waiver that is still waiting for approval.",
};

/** Which group a person is in, or null for nobody a group reaches. */
export function groupForStatus(status: LifecycleStatus): ClubMessageGroup | null {
  switch (status) {
    case "member":
      return "members";
    case "visitor":
      return "visitors";
    case "lapsed":
      return "lapsed";
    case "applicant":
      return "applicants";
    case "lead":
      return null;
  }
}

/**
 * Which group a person is in for a message. The funnel phase, with one
 * correction: somebody "lapsed" only because their free trial ran out never
 * paid, so they are a visitor here, not a lapsed member. That is the person
 * the two groups were split to tell apart.
 */
export function groupForPerson(
  person: Pick<MessagePerson, "lifecycle_status" | "ever_paid">,
): ClubMessageGroup | null {
  const group = groupForStatus(person.lifecycle_status);
  return group === "lapsed" && !person.ever_paid ? "visitors" : group;
}

/** A person as the audience reads them. */
export type MessagePerson = HouseholdLink & {
  /** What to call them, for "this is for Bea". */
  name: string;
  lifecycle_status: LifecycleStatus;
  /**
   * Whether they ever held a paid membership (not the free trial). The funnel
   * calls anybody whose membership ended "lapsed", a finished trial included;
   * a message tells those two apart (`groupForPerson`).
   */
  ever_paid?: boolean;
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
 * Everybody in a ticked group, plus each person ticked one by one, who has not
 * left the club, folded to the inbox the club writes to about them. A parent
 * who is in no ticked group still gets it for a child who is, and their email
 * names the child. An inbox whose owner has left the club gets nothing at all.
 * A person ticked one by one is reached only while they are in some group:
 * a lead, or somebody who has left, is not reached by naming their id.
 */
export function messageAudience(input: {
  people: MessagePerson[];
  groups: Iterable<ClubMessageGroup>;
  personIds?: Iterable<string>;
}): MessageInbox[] {
  const groups = new Set(input.groups);
  const named = new Set([...(input.personIds ?? [])].map((id) => id.toLowerCase()));
  const byId = new Map(input.people.map((p) => [p.user_id.toLowerCase(), p]));
  const byInbox = new Map<string, MessageInbox>();

  for (const person of input.people) {
    if (person.archived) continue;
    const group = groupForPerson(person);
    const id = person.user_id.toLowerCase();
    if (!group || !(groups.has(group) || named.has(id))) continue;

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

/**
 * One person in a group, as the screen lists them for ticking. Their email goes
 * to `inbox_user_id`, which is somebody else (`inbox_name`) for a child.
 */
export type GroupPerson = {
  user_id: string;
  name: string;
  group: ClubMessageGroup;
  inbox_user_id: string;
  /** Who reads their email, when that is not them: the parent, for a child. */
  inbox_name: string | null;
};

/**
 * Everybody a group can reach, person by person, in name order: the screen's
 * lists under each group, and the agent's `list_message_people`. The same
 * rules as `messageAudience`, so a person listed here is a person who can be
 * reached, and nobody who has left is listed.
 */
export function groupPeople(people: MessagePerson[]): GroupPerson[] {
  const byId = new Map(people.map((p) => [p.user_id.toLowerCase(), p]));
  const out: GroupPerson[] = [];
  for (const person of people) {
    if (person.archived) continue;
    const group = groupForPerson(person);
    if (!group) continue;
    const id = person.user_id.toLowerCase();
    const contactId = contactUserIdFor(person).toLowerCase();
    const contact = byId.get(contactId);
    if (contact?.archived) continue;
    out.push({
      user_id: id,
      name: person.name || "No name on file",
      group,
      inbox_user_id: contactId,
      inbox_name: contactId === id ? null : contact?.name || "their parent",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Turn the screen's ticks into what is sent: a group whose every person is
 * ticked goes as the whole group, and a group with somebody unticked goes as
 * the people kept. Sending the whole group, rather than its list, is what lets
 * the history say "Members" and means somebody who joined while the screen was
 * open is not left out.
 */
export function choiceFromTicks(
  people: GroupPerson[],
  ticked: ReadonlySet<string>,
): { groups: ClubMessageGroup[]; person_ids: string[] } {
  const groups: ClubMessageGroup[] = [];
  const person_ids: string[] = [];
  for (const group of clubMessageGroups) {
    const inGroup = people.filter((p) => p.group === group);
    if (inGroup.length === 0) continue;
    const kept = inGroup.filter((p) => ticked.has(p.user_id));
    if (kept.length === inGroup.length) groups.push(group);
    else person_ids.push(...kept.map((p) => p.user_id));
  }
  return { groups, person_ids };
}

/** Where a lead came from: the interest form or the contact form. */
export const leadSources = ["interest", "contact"] as const;
export type LeadSource = (typeof leadSources)[number];

/** An interest registration or a contact message, as the lead list reads it. */
export type LeadRegistration = {
  id: string;
  source: LeadSource;
  name: string;
  email: string;
  created_at: string;
  promotion_consent: boolean;
};

/** One lead a manager can tick: the address, and the entry that stands for it. */
export type LeadCandidate = {
  /**
   * The newest entry for this address, from either form. Its row is what a
   * send records, which is how deleting the lead also deletes that record.
   */
  registration_id: string;
  /** Which form that newest entry came from. */
  source: LeadSource;
  /** Every form this address has used, interest first. */
  sources: LeadSource[];
  name: string;
  email: string;
  /** When they last filled in either form. */
  registered_at: string;
  /** Whether any of their entries ticked "keep me posted". */
  promotion_consent: boolean;
  /** Ticked to start with: they registered in the last `LEAD_PRESELECT_DAYS`. */
  preselected: boolean;
};

/**
 * Every lead a message could go to, newest first.
 *
 * The same dedupe the users page makes (`aggregateClubUsers`): one row per
 * address across both forms, the newest entry standing for it, and an address
 * that now belongs to a person is left out, because they get the message as
 * that person if their group is ticked.
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
      source: latest.source,
      sources: leadSources.filter((src) => list.some((r) => r.source === src)),
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
    // Emphasis markers only where they wrap a word, so `5 * 3` keeps its
    // star. Underscores count only at a word's edge, as markdown reads them,
    // so `club_room and side_door` keeps both of its.
    .replace(/(\*\*|\*|~~|`)(?=\S)([^]*?\S)\1/g, "$2")
    .replace(/(^|[^\w])(__|_)(?=\S)([^]*?\S)\2(?!\w)/g, "$1$3")
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

/**
 * Who it goes to: whole groups, people ticked one by one, and leads. At least
 * one of the three. A screen with a group fully ticked sends the group; one
 * with some of a group unticked sends the people it kept.
 */
export const clubMessageAudienceSchema = z.object({
  groups: z.array(z.enum(clubMessageGroups)).max(clubMessageGroups.length).default([]),
  person_ids: z.array(z.string().uuid()).max(5000).default([]),
  lead_ids: z.array(z.string().uuid()).max(5000).default([]),
});

const sendClubMessageObject = clubMessageDraftSchema
  .merge(clubMessageAudienceSchema)
  .extend({ message_id: z.string().uuid() });

const someoneTicked = <T extends { groups: unknown[]; person_ids: unknown[]; lead_ids: unknown[] }>(
  d: T,
) => d.groups.length > 0 || d.person_ids.length > 0 || d.lead_ids.length > 0;
const someoneTickedMessage = {
  message: "Tick at least one person.",
  path: ["groups"],
};

export const sendClubMessageSchema = sendClubMessageObject.refine(
  someoneTicked,
  someoneTickedMessage,
);

export const sendClubMessageTestSchema = clubMessageDraftSchema.extend({
  client_submission_id: z.string().uuid(),
});

// The manager agent API's shapes: the same rules, refusing unknown keys so a
// misspelt param is an error rather than silently ignored.

export const agentClubMessageIdSchema = z.object({ id: z.string().uuid() }).strict();

export const agentClubMessageAudienceSchema = z
  .object({
    groups: clubMessageAudienceSchema.shape.groups,
    person_ids: clubMessageAudienceSchema.shape.person_ids,
    lead_ids: clubMessageAudienceSchema.shape.lead_ids,
  })
  .strict();

export const agentSendClubMessageSchema = sendClubMessageObject
  .strict()
  .refine(someoneTicked, someoneTickedMessage);

export const agentSendClubMessageTestSchema = clubMessageDraftSchema
  .extend({ client_submission_id: z.string().uuid().optional() })
  .strict();
