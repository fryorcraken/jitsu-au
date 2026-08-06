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
import { generateRawToken, hashToken, tokenPreview } from "@/lib/manager-api-tokens";
import {
  digestSections,
  digestSubject,
  hasDigestContent,
  shouldEmail,
  type NotificationItem,
  type NotificationKind,
  type NotificationSubjectType,
} from "@/lib/notifications";
import { greetingName } from "@/lib/validation";
import { userEmails } from "@/lib/supabase-rpc";

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

  const { data: existing } = await db
    .from("notification_tokens")
    .select("token")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing?.token) return url(existing.token);

  const raw = generateRawToken();
  const { error } = await db.from("notification_tokens").insert({
    user_id: userId,
    token: raw,
    token_hash: await hashToken(raw),
    token_prefix: tokenPreview(raw),
  });
  if (!error) return url(raw);

  const { data: raced } = await db
    .from("notification_tokens")
    .select("token")
    .eq("user_id", userId)
    .maybeSingle();
  if (raced?.token) return url(raced.token);

  // No token, so no signed-out link. The signed-in page still works, and an
  // email with a settings link that needs a login beats no email at all.
  console.error(`[notifications] could not mint a settings token for ${userId}`);
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

/** One person's email address, or null. */
async function emailFor(db: AdminClient, userId: string): Promise<string | null> {
  const { data, error } = await userEmails(db, [userId]);
  if (error || !data?.length) return null;
  return data[0].email ?? null;
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
    .select("id, user_id, kind, title, body, href, read_at, created_at")
    .is("emailed_at", null)
    .order("created_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(error.message);

  const pending = rows ?? [];
  if (pending.length === 0) return { considered: 0, recipients: 0, sent: 0 };

  const byUser = new Map<string, NotificationItem[]>();
  for (const r of pending) {
    const list = byUser.get(r.user_id) ?? [];
    list.push({
      id: r.id,
      kind: r.kind as NotificationKind,
      title: r.title,
      body: r.body,
      href: r.href,
      read_at: r.read_at,
      created_at: r.created_at,
    });
    byUser.set(r.user_id, list);
  }

  const apiKey = process.env.LOVABLE_API_KEY;
  const sendUrl = process.env.LOVABLE_SEND_URL;
  if (!apiKey) {
    // Deliberately NOT stamped. With no way to send, these are still owed, and
    // stamping them would silently swallow a day of notifications the first
    // time the key went missing.
    console.warn("[notifications] LOVABLE_API_KEY not set — skipping the digest");
    return { considered: pending.length, recipients: byUser.size, sent: 0 };
  }

  // Date in the club's own terms, so the idempotency key matches what a person
  // would call "today" and a re-run after midnight UTC is still the same digest.
  const day = now.toISOString().slice(0, 10);
  let sent = 0;

  for (const [userId, items] of byUser) {
    try {
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

      const sections = digestSections(items, prefs, { isManager: Boolean(manager) });
      const ids = items.map((i) => i.id);

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

  return { considered: pending.length, recipients: byUser.size, sent };
}
