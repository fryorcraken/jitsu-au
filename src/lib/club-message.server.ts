// Server-only: work out who a club message reaches, send it, and read back
// what was sent. The rules are in `club-message.ts`; this is the I/O around
// them. Shared by the manager screen's server functions
// (`club-message.functions.ts`) and the manager agent API, so a manager and an
// agent send through exactly the same code. Product rules:
// docs/club-messages.md.
//
// It extends the notification seam the plan announcement uses rather than
// running a fan-out of its own, for the people half: one `notifications` row
// per inbox (`writeNotifications`, which makes a retry safe), emailed by
// `sendPendingNotifications` (which leaves a failed send pending rather than
// lost), and anything left is sent by the morning summary. Leads have no
// person record and so no notification row; they get a recipient row of their
// own, sent here in the same bounded batches.
//
// ⚠️ The transport is Lovable Emails, which is meant for one-person emails and
// caps the whole workspace at 100 an hour (Pro). Club notices go through it
// because the club is small (a few dozen inboxes); see docs/club-messages.md,
// "Why notices use the club's email service", before raising any limit here.
//
// Lazy-imported from inside handlers only: it pulls in the email renderer and
// the service-role sender, neither of which may reach the client bundle.
import * as React from "react";
import { render } from "@react-email/render";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/integrations/supabase/types";
import { ClubMessageEmail } from "@/lib/email-templates/club-message";
import { SITE_ORIGIN } from "@/lib/site-origin";
import { SITE_NAME } from "@/lib/email-sender";
import { clubReplyTo, sendEmail } from "@/lib/send-email.server";
import {
  IMMEDIATE_SEND_BATCH,
  IMMEDIATE_SENDS_PER_REQUEST,
  sendPendingNotifications,
  writeNotifications,
} from "@/lib/notification-email.server";
import { deliveryRecipientFor } from "@/lib/household-email";
import { userEmails } from "@/lib/supabase-rpc";
import {
  aggregateClubUsers,
  contactUserIds,
  type ClubUserProfile,
  type ClubUserWaiver,
} from "@/lib/club-users";
import {
  CLUB_MESSAGE_SUBJECT,
  CLUB_NOTICE_KIND,
  clubMessageGroups,
  clubMessageHref,
  leadCandidates,
  messageAudience,
  messageProgress,
  plainExcerpt,
  type ClubMessageGroup,
  type ClubMessageKind,
  type ClubMessageProgress,
  type LeadCandidate,
  type MessageInbox,
  type MessagePerson,
} from "@/lib/club-message";
import { forWhomText } from "@/lib/plan-announcement";
import { greetingName, type PersonNameParts } from "@/lib/validation";

type AdminClient = SupabaseClient<Database>;

/** A refusal the caller can act on, with a code the agent API passes through. */
export class ClubMessageError extends Error {
  constructor(
    readonly code: "submission_conflict" | "no_recipients" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "ClubMessageError";
  }
}

/** PostgREST answers at most this many rows a request, so longer reads page. */
const PAGE = 1000;

/** Every row a query would return, a page at a time. */
async function readAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/** Everybody a message could reach, read from the database. */
export type MessageDirectory = {
  people: MessagePerson[];
  leads: LeadCandidate[];
  /** Names to greet each inbox by, keyed by lowercased user id. */
  names: Map<string, PersonNameParts>;
};

/**
 * The club as a message sees it: every person with their funnel phase, and
 * every lead that could be ticked.
 *
 * The phase comes from `aggregateClubUsers`, the aggregation behind the users
 * page, so a manager who filters that page for members sees the same people
 * the Members box reaches.
 *
 * Every read throws rather than degrading. The users page tolerates a failed
 * address lookup (leads then show up twice for a moment); a send must not,
 * because a lead not matched to their person record would be emailed twice,
 * and a missing waivers read would drop everybody to `lead`.
 */
export async function loadMessageDirectory(
  db: AdminClient,
  now = new Date(),
): Promise<MessageDirectory> {
  const [profiles, waivers, memberships, plans, registrations] = await Promise.all([
    readAll<ClubUserProfile & { archived_at: string | null }>((from, to) =>
      db
        .from("profiles")
        .select(
          "user_id, first_name, middle_name, last_name, preferred_name, phone, uts_student_number, gi_size, belt_size, created_at, guardian_user_id, archived_at",
        )
        .order("user_id")
        .range(from, to),
    ),
    readAll<ClubUserWaiver>((from, to) =>
      db.from("waivers").select("user_id, signed_at, approval_status").order("id").range(from, to),
    ),
    readAll<Database["public"]["Tables"]["memberships"]["Row"]>((from, to) =>
      db.from("memberships").select("*").order("id").range(from, to),
    ),
    readAll<{ id: string; name: string; kind: string }>((from, to) =>
      db.from("membership_plans").select("id, name, kind").order("id").range(from, to),
    ),
    readAll<{
      id: string;
      name: string;
      email: string;
      created_at: string;
      promotion_consent: boolean;
    }>((from, to) =>
      db
        .from("interest_registrations")
        .select("id, name, email, created_at, promotion_consent")
        .order("id")
        .range(from, to),
    ),
  ]);

  const contactIds = contactUserIds(profiles);
  const emails = contactIds.length ? await userEmails(db, contactIds) : { data: [], error: null };
  if (emails.error) throw new Error(emails.error.message);

  const aggregated = aggregateClubUsers({
    profiles,
    emails: (emails.data ?? []).map((e) => ({ user_id: e.user_id, email: e.email })),
    countHouseholdMemberships: true,
    waivers,
    // Leads are listed separately below, with the fields a send needs.
    leads: [],
    memberships: memberships.map((m) => ({
      user_id: m.user_id,
      plan_id: m.plan_id,
      status: m.status,
      price_cents: m.price_cents,
      is_student: m.is_student,
      uts_student_number: m.uts_student_number,
      sessions_remaining: m.sessions_remaining,
      created_at: m.created_at,
    })),
    plans,
    roles: [],
  });

  const archived = new Set(
    profiles.filter((p) => p.archived_at).map((p) => p.user_id.toLowerCase()),
  );
  const people: MessagePerson[] = aggregated.flatMap((u) =>
    u.user_id
      ? [
          {
            user_id: u.user_id,
            guardian_user_id: u.guardian_user_id,
            name: u.greeting_name ?? u.name ?? "",
            lifecycle_status: u.lifecycle_status,
            archived: archived.has(u.user_id.toLowerCase()),
          },
        ]
      : [],
  );

  return {
    people,
    leads: leadCandidates({
      registrations,
      personEmails: (emails.data ?? []).map((e) => e.email),
      now,
    }),
    names: new Map(profiles.map((p) => [p.user_id.toLowerCase(), p])),
  };
}

/** Who a choice of groups and leads reaches: the inboxes, and the leads still eligible. */
function resolveAudience(
  dir: MessageDirectory,
  choice: { groups: readonly ClubMessageGroup[]; leadIds: readonly string[] },
): { inboxes: MessageInbox[]; leads: LeadCandidate[] } {
  const wanted = new Set(choice.leadIds.map((id) => id.toLowerCase()));
  return {
    inboxes: messageAudience({ people: dir.people, groups: choice.groups }),
    leads: dir.leads.filter((l) => wanted.has(l.registration_id.toLowerCase())),
  };
}

export type AudienceCount = {
  /** Emails this choice would send: inboxes plus leads. */
  emails: number;
  inboxes: number;
  leads: number;
  /** Inboxes each group reaches on its own, for the screen's tick boxes. */
  by_group: Record<ClubMessageGroup, number>;
};

/** How many emails a choice would send right now, for the screen and the confirm. */
export async function countClubMessageAudience(
  db: AdminClient,
  choice: { groups: readonly ClubMessageGroup[]; leadIds: readonly string[] },
): Promise<AudienceCount> {
  const dir = await loadMessageDirectory(db);
  const { inboxes, leads } = resolveAudience(dir, choice);
  const by_group = Object.fromEntries(
    clubMessageGroups.map((g) => [g, messageAudience({ people: dir.people, groups: [g] }).length]),
  ) as Record<ClubMessageGroup, number>;
  return {
    emails: inboxes.length + leads.length,
    inboxes: inboxes.length,
    leads: leads.length,
    by_group,
  };
}

/** Every lead a message could be sent to, for the screen's list. */
export async function listMessageLeads(db: AdminClient): Promise<LeadCandidate[]> {
  return (await loadMessageDirectory(db)).leads;
}

/** The message as the email renders it, shared by the real send and the test. */
async function composeEmail(opts: {
  subject: string;
  body: string;
  greeting: string;
  forWhom: string | null;
  audience: "person" | "lead";
  replyTo: string | null;
  test?: boolean;
}): Promise<{ html: string; text: string }> {
  const el = React.createElement(ClubMessageEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_ORIGIN,
    greeting: opts.greeting,
    subject: opts.subject,
    body: opts.body,
    forWhom: opts.forWhom,
    audience: opts.audience,
    replyTo: opts.replyTo,
    test: opts.test,
  });
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
  return { html, text };
}

/**
 * Send a test copy to the manager pressing the button, at their own address.
 *
 * Keyed per click, so pressing it twice sends two (somebody checking a fix
 * wants the second one), while an automatic retry of one press sends one.
 */
export async function sendClubMessageTest(
  db: AdminClient,
  input: { managerId: string; subject: string; body: string; clickId: string },
): Promise<{ to: string }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("Email is not set up on this site, so nothing can be sent.");
  const me = await deliveryRecipientFor(db, input.managerId);
  if (!me.email) throw new Error("We could not find an email address on your account.");
  const replyTo = await clubReplyTo(db);
  const { html, text } = await composeEmail({
    subject: input.subject,
    body: input.body,
    greeting: me.greetingName,
    forWhom: null,
    audience: "person",
    replyTo,
    test: true,
  });
  await sendEmail({
    apiKey,
    sendUrl: process.env.LOVABLE_SEND_URL,
    to: me.email,
    subject: `Test: ${input.subject}`,
    html,
    text,
    idempotencyKey: `club-message-test-${input.clickId}`,
    replyTo,
  });
  return { to: me.email };
}

export type SendResult = ClubMessageProgress & { message_id: string; sent_at: string };

type StoredAudience = { groups: ClubMessageGroup[]; lead_ids: string[] };

function readStoredAudience(value: Json): StoredAudience {
  const v = (value ?? {}) as { groups?: unknown; lead_ids?: unknown };
  const groups = Array.isArray(v.groups)
    ? (v.groups.filter((g) =>
        (clubMessageGroups as readonly unknown[]).includes(g),
      ) as ClubMessageGroup[])
    : [];
  const lead_ids = Array.isArray(v.lead_ids)
    ? v.lead_ids.filter((id): id is string => typeof id === "string")
    : [];
  return { groups, lead_ids };
}

/**
 * Send one club message, or finish sending it.
 *
 * `messageId` is minted by the caller and is the whole retry story:
 *
 * - The first call records the message and writes a recipient row for every
 *   inbox and every ticked lead, then stamps `recipients_written_at`. From
 *   then on the list is frozen, so "Send the rest now" an hour later finishes
 *   the same list rather than adding whoever joined since.
 * - Every call then emails whatever is still unsent, up to
 *   `IMMEDIATE_SENDS_PER_REQUEST` between people and leads.
 * - The same id with different words is refused (`submission_conflict`), so
 *   an edit after a failed send cannot quietly go out under the old message's
 *   record. The screen starts a new message for that.
 */
export async function sendClubMessage(
  db: AdminClient,
  input: {
    messageId: string;
    kind: ClubMessageKind;
    subject: string;
    body: string;
    groups: readonly ClubMessageGroup[];
    leadIds: readonly string[];
    actorId: string | null;
  },
): Promise<SendResult> {
  const id = input.messageId.toLowerCase();
  let message = await readMessage(db, id);
  if (message) {
    if (
      message.kind !== input.kind ||
      message.subject !== input.subject ||
      message.body !== input.body
    )
      throw new ClubMessageError(
        "submission_conflict",
        "That message id was already used for a different message. Start a new message.",
      );
  } else {
    const audience: StoredAudience = { groups: [...input.groups], lead_ids: [...input.leadIds] };
    const { error } = await db.from("club_messages").insert({
      id,
      kind: input.kind,
      subject: input.subject,
      body: input.body,
      audience: audience as unknown as Json,
      sent_by: input.actorId,
    });
    // Two calls with the same id at once: the loser reads the winner's row.
    if (error && error.code !== "23505") throw new Error(error.message);
    message = await readMessage(db, id);
    if (!message) throw new Error("The message could not be saved.");
  }

  const stored = readStoredAudience(message.audience);
  const [dir, replyTo] = await Promise.all([loadMessageDirectory(db), clubReplyTo(db)]);
  const { inboxes, leads } = resolveAudience(dir, {
    groups: stored.groups,
    leadIds: stored.lead_ids,
  });

  if (!message.recipients_written_at) {
    if (inboxes.length + leads.length === 0)
      throw new ClubMessageError("no_recipients", "Nobody you ticked can be emailed right now.");
    const href = clubMessageHref(id);
    const excerpt = plainExcerpt(message.body);
    await writeNotifications(
      db,
      inboxes.map((inbox) => ({
        userId: inbox.contactUserId,
        kind: CLUB_NOTICE_KIND,
        subjectType: CLUB_MESSAGE_SUBJECT,
        subjectId: id,
        actorId: input.actorId,
        title: message.subject.slice(0, 200),
        body: excerpt.slice(0, 500),
        href,
      })),
      { throwOnError: true },
    );
    if (leads.length > 0) {
      const { error } = await db.from("club_message_lead_recipients").upsert(
        leads.map((l) => ({ message_id: id, interest_registration_id: l.registration_id })),
        { onConflict: "message_id,interest_registration_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(error.message);
    }
    const { error } = await db
      .from("club_messages")
      .update({ recipients_written_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
  }

  const byInbox = new Map(inboxes.map((i) => [i.contactUserId, i]));
  const people = await sendPendingNotifications(db, {
    kind: CLUB_NOTICE_KIND,
    subjectId: id,
    compose: async (row, to) => {
      const inbox = byInbox.get(row.user_id.toLowerCase());
      const reader = dir.names.get(row.user_id.toLowerCase());
      const { html, text } = await composeEmail({
        subject: message.subject,
        body: message.body,
        greeting: reader ? greetingName(reader) : "",
        forWhom: inbox && inbox.dependants.length > 0 ? forWhomText(inbox) : null,
        audience: "person",
        replyTo,
      });
      return {
        to,
        subject: message.subject,
        html,
        text,
        // The row is one inbox for one message, so two calls that pick up
        // the same pending row send one email between them.
        idempotencyKey: `club-message-${row.id}`,
        replyTo,
      };
    },
  });

  const budget = IMMEDIATE_SENDS_PER_REQUEST - people.sent - people.failed - people.skipped;
  if (budget > 0) await sendPendingLeads(db, { message, budget, replyTo });

  const progress = await loadProgress(db, [id]);
  return {
    message_id: id,
    sent_at: message.created_at,
    ...(progress.get(id) ?? { recipients: 0, emailed: 0, pending: 0 }),
  };
}

type MessageRow = Database["public"]["Tables"]["club_messages"]["Row"];

async function readMessage(db: AdminClient, id: string): Promise<MessageRow | null> {
  const { data, error } = await db.from("club_messages").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Email the leads this message still owes, in the same bounded batches as people. */
async function sendPendingLeads(
  db: AdminClient,
  opts: { message: MessageRow; budget: number; replyTo: string | null },
): Promise<void> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) return;
  const { data, error } = await db
    .from("club_message_lead_recipients")
    .select("id, interest_registrations(name, email)")
    .eq("message_id", opts.message.id)
    .is("emailed_at", null)
    .order("created_at", { ascending: true })
    .limit(opts.budget);
  if (error) throw new Error(error.message);
  const pending = data ?? [];

  for (let i = 0; i < pending.length; i += IMMEDIATE_SEND_BATCH) {
    const batch = pending.slice(i, i + IMMEDIATE_SEND_BATCH);
    const outcomes = await Promise.allSettled(
      batch.map(async (row) => {
        const lead = row.interest_registrations;
        if (!lead?.email) return false;
        const { html, text } = await composeEmail({
          subject: opts.message.subject,
          body: opts.message.body,
          greeting: lead.name.trim().split(/\s+/)[0] ?? "",
          forWhom: null,
          audience: "lead",
          replyTo: opts.replyTo,
        });
        await sendEmail({
          apiKey,
          sendUrl: process.env.LOVABLE_SEND_URL,
          to: lead.email.trim(),
          subject: opts.message.subject,
          html,
          text,
          idempotencyKey: `club-message-lead-${row.id}`,
          replyTo: opts.replyTo,
        });
        return true;
      }),
    );
    const done = batch
      .filter((_, n) => {
        const o = outcomes[n];
        if (o.status === "rejected")
          console.error("[club-message] lead send failed for a recipient:", o.reason);
        return o.status === "fulfilled" && o.value;
      })
      .map((r) => r.id);
    if (done.length > 0) {
      const { error: stampErr } = await db
        .from("club_message_lead_recipients")
        .update({ emailed_at: new Date().toISOString() })
        .in("id", done);
      if (stampErr) console.error("[club-message] could not stamp lead rows:", stampErr.message);
    }
  }
}

/** How far each message has got, keyed by message id. */
async function loadProgress(
  db: AdminClient,
  ids: string[],
): Promise<Map<string, ClubMessageProgress>> {
  if (ids.length === 0) return new Map();
  const [rows, leadRows] = await Promise.all([
    readAll<{ subject_id: string; emailed_at: string | null }>((from, to) =>
      db
        .from("notifications")
        .select("subject_id, emailed_at")
        .eq("kind", CLUB_NOTICE_KIND)
        .in("subject_id", ids)
        .order("id")
        .range(from, to),
    ),
    readAll<{ message_id: string; emailed_at: string | null }>((from, to) =>
      db
        .from("club_message_lead_recipients")
        .select("message_id, emailed_at")
        .in("message_id", ids)
        .order("id")
        .range(from, to),
    ),
  ]);
  return new Map(
    ids.map((id) => [
      id,
      messageProgress(
        rows.filter((r) => r.subject_id === id),
        leadRows.filter((r) => r.message_id === id),
      ),
    ]),
  );
}

/** One message as the history lists it. */
export type ClubMessageSummary = ClubMessageProgress & {
  id: string;
  kind: ClubMessageKind;
  subject: string;
  sent_at: string;
  sent_by_name: string | null;
  groups: ClubMessageGroup[];
  /** How many leads were ticked when it was sent. */
  lead_count: number;
};

/** The most recent messages, newest first, with how far each has got. */
export async function listClubMessages(
  db: AdminClient,
  opts: { limit?: number } = {},
): Promise<ClubMessageSummary[]> {
  const { data, error } = await db
    .from("club_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 100);
  if (error) throw new Error(error.message);
  const messages = data ?? [];
  const [progress, names] = await Promise.all([
    loadProgress(
      db,
      messages.map((m) => m.id),
    ),
    senderNames(db, messages),
  ]);
  return messages.map((m) => summarise(m, progress.get(m.id), names));
}

/** One message in full, for its page in the history. */
export async function getClubMessage(
  db: AdminClient,
  id: string,
): Promise<ClubMessageSummary & { body: string }> {
  const message = await readMessage(db, id.toLowerCase());
  if (!message) throw new ClubMessageError("not_found", "That message does not exist.");
  const [progress, names] = await Promise.all([
    loadProgress(db, [message.id]),
    senderNames(db, [message]),
  ]);
  return { ...summarise(message, progress.get(message.id), names), body: message.body };
}

/**
 * A message as a member reads it on the site, or null if it was not sent to
 * them. "Sent to them" means a row of theirs exists: the row is on the inbox,
 * so a parent can read what they were sent about their child.
 */
export async function getClubMessageForReader(
  db: AdminClient,
  input: { messageId: string; userId: string },
): Promise<{ subject: string; body: string; sent_at: string } | null> {
  const id = input.messageId.toLowerCase();
  const { data: row, error } = await db
    .from("notifications")
    .select("id")
    .eq("kind", CLUB_NOTICE_KIND)
    .eq("subject_id", id)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return null;
  const message = await readMessage(db, id);
  if (!message) return null;
  return { subject: message.subject, body: message.body, sent_at: message.created_at };
}

async function senderNames(db: AdminClient, messages: MessageRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(messages.flatMap((m) => (m.sent_by ? [m.sent_by] : [])))];
  if (ids.length === 0) return new Map();
  const { data, error } = await db
    .from("profiles")
    .select("user_id, first_name, middle_name, last_name, preferred_name")
    .in("user_id", ids);
  // Only a label in the history: a failed read leaves it blank rather than
  // hiding the history itself.
  if (error) console.error("[club-message] could not read sender names:", error.message);
  return new Map((data ?? []).map((p) => [p.user_id, greetingName(p)]));
}

function summarise(
  m: MessageRow,
  progress: ClubMessageProgress | undefined,
  names: Map<string, string>,
): ClubMessageSummary {
  const stored = readStoredAudience(m.audience);
  return {
    id: m.id,
    kind: m.kind as ClubMessageKind,
    subject: m.subject,
    sent_at: m.created_at,
    sent_by_name: (m.sent_by ? names.get(m.sent_by) : null) || null,
    groups: stored.groups,
    lead_count: stored.lead_ids.length,
    ...(progress ?? { recipients: 0, emailed: 0, pending: 0 }),
  };
}
