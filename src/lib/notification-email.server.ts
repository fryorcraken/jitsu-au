// Server-only: writes notification rows and sends the emails that go with them.
//
// Like `waiver-email.server.ts` and `interest-email.server.ts`, this pulls in
// server-only dependencies (the Lovable send API, the React-email renderer) so
// it must never reach the client bundle. It is named `*.server.ts` and is only
// ever lazy-imported from inside a server-function handler or an API route.
//
// Writing the row and sending the email live together on purpose: an instant
// reply email is "insert, then send, then stamp `emailed_at`", and splitting
// that across modules is how a row ends up mailed twice or never.
import * as React from "react";
import { render } from "@react-email/render";
import { sendLovableEmail } from "@lovable.dev/email-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { CommentReplyEmail } from "@/lib/email-templates/comment-reply";
import {
  NotificationDigestEmail,
  type DigestBlock,
} from "@/lib/email-templates/notification-digest";
import { CLUB_TIME_ZONE, clubLocalDate } from "@/lib/calendar";
import { generateRawToken, hashToken, tokenPreview } from "@/lib/manager-api-tokens";
import {
  digestSections,
  digestSubject,
  hasDigestContent,
  mergeHouseholdItems,
  shouldEmail,
  type DigestCandidate,
  type NotificationKind,
  type NotificationSubjectType,
} from "@/lib/notifications";
import { greetingName } from "@/lib/validation";
import { contactUserIdOf, deliveryEmailFor, loadHouseholdContacts } from "@/lib/household-email";

// Sender configuration mirrors the auth-email webhook and every other email
// this app sends.
const SITE_NAME = "UTS Jitsu";
// Must match SENDER_DOMAIN so DKIM/SPF align under DMARC.
const FROM_DOMAIN = "notify.jitsu.au";
const SENDER_DOMAIN = "notify.jitsu.au";
const SITE_URL = "https://jitsu.au";
const FROM = `${SITE_NAME} <noreply@${FROM_DOMAIN}>`;

type AdminClient = SupabaseClient<Database>;

async function sendOne(opts: {
  apiKey: string;
  sendUrl?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}) {
  await sendLovableEmail(
    {
      to: opts.to,
      from: FROM,
      sender_domain: SENDER_DOMAIN,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      purpose: "transactional",
      idempotency_key: opts.idempotencyKey,
    },
    { apiKey: opts.apiKey, sendUrl: opts.sendUrl },
  );
}

/** Turn a stored site-relative `href` into something an email client can open. */
export function absoluteUrl(href: string): string {
  return `${SITE_URL}${href}`;
}

/**
 * The person's settings link, minted on first need.
 *
 * Get-or-create with a race fallback, the same shape `calendar.functions.ts`
 * uses for a feed token: two emails composed at once for the same person would
 * otherwise both try to insert, and the loser must end up with the winner's
 * token rather than an error. Returns null if a token cannot be established, in
 * which case the caller falls back to the signed-in page.
 */
export async function settingsUrlFor(db: AdminClient, userId: string): Promise<string> {
  const url = (token: string) => `${SITE_URL}/email-settings/${token}`;

  // The token belongs to the person who READS the mail, not the person the mail
  // is about. `notification_tokens` is one row per user, so minting one per
  // child would hand a parent a different "email settings" link in every email
  // about a different child, each opening a page of switches that governs only
  // that child's mail. There is one inbox, so there is one set of switches, so
  // there is one token. Resolved here rather than at each call site so no
  // caller can mint the wrong one.
  const contactId = await contactUserIdOf(db, userId);

  const { data: existing } = await db
    .from("notification_tokens")
    .select("token")
    .eq("user_id", contactId)
    .maybeSingle();
  if (existing?.token) return url(existing.token);

  const raw = generateRawToken();
  const { error } = await db.from("notification_tokens").insert({
    user_id: contactId,
    token: raw,
    token_hash: await hashToken(raw),
    token_prefix: tokenPreview(raw),
  });
  if (!error) return url(raw);

  const { data: raced } = await db
    .from("notification_tokens")
    .select("token")
    .eq("user_id", contactId)
    .maybeSingle();
  if (raced?.token) return url(raced.token);

  // No token, so no signed-out link. The signed-in page still works, and an
  // email with a settings link that needs a login beats no email at all.
  console.error(`[notifications] could not mint a settings token for ${contactId}`);
  return `${SITE_URL}/notifications`;
}

export type NotificationDraft = {
  userId: string;
  kind: NotificationKind;
  subjectType: NotificationSubjectType;
  subjectId: string;
  actorId?: string | null;
  title: string;
  body?: string | null;
  href: string;
};

/**
 * Insert notification rows, ignoring any that already exist.
 *
 * `ON CONFLICT DO NOTHING` against `notifications_user_kind_subject_key` is what
 * makes every writer safe to call twice: a post unpublished and republished, or
 * a retried request, cannot produce a second notification. Returns the rows
 * that were actually new, so the caller only emails about those.
 */
export async function writeNotifications(
  db: AdminClient,
  drafts: NotificationDraft[],
): Promise<{ id: string; user_id: string; kind: NotificationKind }[]> {
  if (drafts.length === 0) return [];
  const { data, error } = await db
    .from("notifications")
    .upsert(
      drafts.map((d) => ({
        user_id: d.userId,
        kind: d.kind,
        subject_type: d.subjectType,
        subject_id: d.subjectId,
        actor_id: d.actorId ?? null,
        title: d.title,
        body: d.body ?? null,
        href: d.href,
      })),
      { onConflict: "user_id,kind,subject_id", ignoreDuplicates: true },
    )
    .select("id, user_id, kind");
  if (error) {
    // Never allowed to fail the comment somebody just posted.
    console.error("[notifications] could not write notifications:", error.message);
    return [];
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    user_id: r.user_id,
    kind: r.kind as NotificationKind,
  }));
}

/**
 * Where a message ABOUT this person goes.
 *
 * A dependant has no mailbox of their own -- their `auth.users` address is a
 * reserved, non-deliverable string that nothing may ever send to -- so this
 * resolves through their guardian. It is the delivery half of
 * `household-email.ts`, and it replaced a direct `userEmails` lookup rather
 * than sitting beside one, so there is no route left from here to an address
 * that skips the rule.
 */
async function emailFor(db: AdminClient, userId: string): Promise<string | null> {
  return deliveryEmailFor(db, userId);
}

/**
 * Email somebody straight away that they were replied to, then stamp the row so
 * the digest never mentions it again.
 *
 * Best-effort throughout: a missing API key, an unknown address or a failed send
 * is logged and swallowed. The notification is already on their page either way,
 * which is the point of storing it rather than only mailing it.
 */
export async function sendReplyNotification(
  db: AdminClient,
  opts: {
    notificationId: string;
    recipientId: string;
    authorName: string;
    preview: string;
    href: string;
    context: string;
  },
): Promise<boolean> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[notifications] LOVABLE_API_KEY not set — skipping reply email");
    return false;
  }

  const { data: prefs } = await db
    .from("notification_preferences")
    .select("reply_to_me, thread_activity, new_blog_post, manager_comment_alerts")
    .eq("user_id", opts.recipientId)
    .maybeSingle();
  if (!shouldEmail(prefs, "reply")) {
    // Switched off. Stamp it anyway so the digest does not pick it up later as
    // an unemailed row: a preference is forward-looking, not a queue.
    await stampEmailed(db, [opts.notificationId]);
    return false;
  }

  const to = await emailFor(db, opts.recipientId);
  if (!to) return false;

  const el = React.createElement(CommentReplyEmail, {
    siteName: SITE_NAME,
    authorName: opts.authorName,
    preview: opts.preview,
    replyUrl: absoluteUrl(opts.href),
    settingsUrl: await settingsUrlFor(db, opts.recipientId),
    context: opts.context,
  });
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);

  try {
    await sendOne({
      apiKey,
      sendUrl: process.env.LOVABLE_SEND_URL,
      to,
      subject: `${opts.authorName} replied to you at ${SITE_NAME}`,
      html,
      text,
      // Keyed by the notification row, which is itself unique per person per
      // subject, so a retry cannot mail the same reply twice.
      idempotencyKey: `reply-${opts.notificationId}`,
    });
    await stampEmailed(db, [opts.notificationId]);
    return true;
  } catch (e) {
    console.error(`[notifications] failed to email a reply to ${opts.recipientId}:`, e);
    return false;
  }
}

/** Mark rows as dealt with, so the digest does not consider them again. */
async function stampEmailed(db: AdminClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db
    .from("notifications")
    .update({ emailed_at: new Date().toISOString() })
    .in("id", ids);
  if (error) console.error("[notifications] could not stamp emailed_at:", error.message);
}

const SECTION_HEADINGS = {
  replies: "Replies to you",
  threads: "Threads you are in",
  posts: "New on the blog",
  moderation: "Comments to review",
} as const;

export type DigestResult = { considered: number; recipients: number; sent: number };

/**
 * The daily run: everything not yet considered for email, grouped by person.
 *
 * Every row it looks at is stamped, including the ones a preference suppressed.
 * That is what keeps switching a kind back on forward-looking instead of
 * releasing weeks of backlog into somebody's inbox.
 */
export async function sendDailyDigests(db: AdminClient, now = new Date()): Promise<DigestResult> {
  const { data: rows, error } = await db
    .from("notifications")
    .select("id, user_id, kind, subject_id, title, body, href, read_at, created_at")
    .is("emailed_at", null)
    .order("created_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(error.message);

  const pending = rows ?? [];
  if (pending.length === 0) return { considered: 0, recipients: 0, sent: 0 };

  // ---- grouped by INBOX, not by person ----
  //
  // This used to group on `notifications.user_id`, which was the same thing
  // until some people stopped having a mailbox of their own. A parent with
  // three children shares one inbox with all three, and `notifyNewBlogPost`
  // writes a row for every person with a club record, so one announcement
  // produced four emails into that inbox on one morning. Every one of them was
  // "correct" and separately idempotent, which is why nothing caught it: the
  // key `digest-${userId}-${day}` made them four distinct sends by
  // construction.
  //
  // So the unit is the contact person. Their own rows and their dependants' are
  // one list, `mergeHouseholdItems` folds the repeats of a single event, and
  // the idempotency key below is keyed on the person who actually receives it.
  //
  // ⚠️ This read is deliberately NOT guarded, and it is the one read here that
  // covers every pending row rather than one recipient's. A failure aborts the
  // whole run, nothing is stamped, and tomorrow tries again. That is the right
  // failure, and the tempting alternative is the wrong one:
  //
  // Falling back to grouping by `user_id` looks like graceful degradation and
  // is data loss. Every group would then be read against ITS OWN preferences,
  // and a dependant's are the club defaults with announcements OFF, so their
  // rows would be judged unwanted, stamped, and never mentioned to the parent
  // who was actually owed them. Silently, once, with no way to get them back.
  // Failing the run costs a day and loses nothing.
  //
  // `loadHouseholdContacts` chunks its own reads, so the size of this list is
  // not what would break it.
  const contacts = await loadHouseholdContacts(
    db,
    pending.map((r) => r.user_id),
  );
  const byContact = new Map<string, DigestCandidate[]>();
  for (const r of pending) {
    const contactId = contacts.contactUserId(r.user_id);
    const list = byContact.get(contactId) ?? [];
    list.push({
      id: r.id,
      user_id: r.user_id,
      subject_id: r.subject_id,
      kind: r.kind as NotificationKind,
      title: r.title,
      body: r.body,
      href: r.href,
      read_at: r.read_at,
      created_at: r.created_at,
    });
    byContact.set(contactId, list);
  }

  const apiKey = process.env.LOVABLE_API_KEY;
  const sendUrl = process.env.LOVABLE_SEND_URL;
  if (!apiKey) {
    // Deliberately NOT stamped. With no way to send, these are still owed, and
    // stamping them would silently swallow a day of notifications the first
    // time the key went missing.
    console.warn("[notifications] LOVABLE_API_KEY not set — skipping the digest");
    return { considered: pending.length, recipients: byContact.size, sent: 0 };
  }

  // The club's date, not the UTC one. The schedule fires in the evening UTC
  // (22:00, see the cron migrations), which is already tomorrow morning in
  // Sydney, so a UTC key would label every digest with the previous day and a
  // re-run either side of midnight UTC would mint two different keys for one
  // morning's mail. Deliberately not restating the hour as a hard fact: it has
  // moved once already and `clubLocalDate` does a real timezone conversion, so
  // nothing here depends on the exact number. `emailed_at` is the real guard;
  // this key is the second belt, and a second belt that changes halfway through
  // the window is not one.
  const day = clubLocalDate(now, CLUB_TIME_ZONE);
  let sent = 0;

  for (const [userId, candidates] of byContact) {
    try {
      // Every question below is about the person who RECEIVES this email. Their
      // switches govern their inbox, their manager role decides whether the
      // moderation section applies, and the greeting is their name. A dependant
      // has none of these in any meaningful sense: no preferences page they can
      // reach, no role, and no need to be greeted in mail they never see.
      const [{ data: prefs }, { data: manager }, profile] = await Promise.all([
        db
          .from("notification_preferences")
          .select("reply_to_me, thread_activity, new_blog_post, manager_comment_alerts")
          .eq("user_id", userId)
          .maybeSingle(),
        db.rpc("has_role", { _user_id: userId, _role: "manager" }),
        db
          .from("profiles")
          .select("first_name, last_name, preferred_name")
          .eq("user_id", userId)
          .maybeSingle(),
      ]);

      const items = mergeHouseholdItems(candidates);
      const sections = digestSections(items, prefs, { isManager: Boolean(manager) });
      // Every row that came in, including the duplicates the merge folded away.
      // Stamping only what was rendered would leave the folded rows pending and
      // mail the family the same post again tomorrow.
      const ids = candidates.map((i) => i.id);

      if (!hasDigestContent(sections)) {
        // Nothing they want to hear about. Stamp and move on, so tomorrow's run
        // is not re-reading the same rows forever.
        await stampEmailed(db, ids);
        continue;
      }

      const to = await emailFor(db, userId);
      if (!to) {
        await stampEmailed(db, ids);
        continue;
      }

      const blocks: DigestBlock[] = (["replies", "threads", "posts", "moderation"] as const)
        .filter((key) => sections[key].length > 0)
        .map((key) => ({
          heading: SECTION_HEADINGS[key],
          lines: sections[key].map((i) => ({
            title: i.title,
            body: i.body,
            url: absoluteUrl(i.href),
          })),
        }));

      const el = React.createElement(NotificationDigestEmail, {
        siteName: SITE_NAME,
        greeting: profile.data ? greetingName(profile.data) : "Hi",
        blocks,
        notificationsUrl: `${SITE_URL}/notifications`,
        settingsUrl: await settingsUrlFor(db, userId),
      });
      const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);

      await sendOne({
        apiKey,
        sendUrl,
        to,
        subject: digestSubject(SITE_NAME, sections),
        html,
        text,
        // Keyed on the RECIPIENT, which is the whole point of the grouping
        // above: three children on one address are one send, and the key says
        // so, so a re-run cannot turn them back into three.
        idempotencyKey: `digest-${userId}-${day}`,
      });
      // Stamp only after a successful send, so a failure retries tomorrow
      // rather than silently dropping the day.
      await stampEmailed(db, ids);
      sent += 1;
    } catch (e) {
      console.error(`[notifications] digest failed for ${userId}:`, e);
    }
  }

  return { considered: pending.length, recipients: byContact.size, sent };
}
