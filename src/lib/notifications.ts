// The rules behind the /notifications page, the sidebar badge and the
// notification emails.
//
// Side-effect free and server-import free, like `src/lib/validation.ts`: the
// server functions and the email sender import from here and do the I/O
// themselves, so every rule below is unit-testable without a request context.
//
// The distinction the whole feature rests on: an ATTENTION item is a standing
// problem (the club's training dates running out), worked out live and cleared
// by fixing it, with no read state. An ACTIVITY item is something that
// happened, stored as a row, unread until somebody looks. They share one badge
// and nothing else.
import type { ManagerNotification } from "@/lib/validation";

/** Every kind of activity notification. Matches the `kind` CHECK in the DB. */
export const notificationKinds = [
  "reply",
  "thread_activity",
  "new_blog_post",
  "blog_comment",
  "kb_comment",
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

/** The things a notification can be about. Matches the `subject_type` CHECK. */
export const notificationSubjectTypes = ["blog_comment", "kb_annotation", "blog_post"] as const;
export type NotificationSubjectType = (typeof notificationSubjectTypes)[number];

/**
 * The four switches a person sees. Not the same list as `notificationKinds`:
 * `blog_comment` and `kb_comment` are both manager moderation alerts and share
 * one switch, because "tell me about new comments" is one decision a manager
 * makes, not two.
 */
export const emailPreferenceKeys = [
  "reply_to_me",
  "thread_activity",
  "new_blog_post",
  "manager_comment_alerts",
] as const;
export type EmailPreferenceKey = (typeof emailPreferenceKeys)[number];

/** The switch that governs whether a given kind is emailed. */
export const preferenceForKind: Record<NotificationKind, EmailPreferenceKey> = {
  reply: "reply_to_me",
  thread_activity: "thread_activity",
  new_blog_post: "new_blog_post",
  blog_comment: "manager_comment_alerts",
  kb_comment: "manager_comment_alerts",
};

/**
 * What somebody gets before they have touched anything.
 *
 * Replies are on because you started the conversation and answering you is the
 * one email people expect. Thread activity is on for the same reason, one step
 * removed, and it only ever reaches people who chose to take part. New-post
 * announcements are OFF: they are the only kind that would reach somebody who
 * did nothing to ask for it, and a club that mails a newsletter to everyone who
 * ever signed a waiver is a club that ends up in spam folders.
 */
export const NOTIFICATION_DEFAULTS: Record<EmailPreferenceKey, boolean> = {
  reply_to_me: true,
  thread_activity: true,
  new_blog_post: false,
  manager_comment_alerts: true,
};

/** A preferences row as stored: NULL on a switch means "never chose". */
export type NotificationPreferenceRow = Partial<Record<EmailPreferenceKey, boolean | null>>;

/**
 * Resolve one switch. A NULL falls back to the club default, which is the whole
 * point of the column being nullable: "never chose" has to stay distinguishable
 * from "deliberately off", or changing a default later moves the wrong people.
 * A missing row behaves as all-NULL, so somebody who has never opened the page
 * needs no row written before they can be emailed.
 */
export function resolveNotificationPreference(
  row: NotificationPreferenceRow | null | undefined,
  key: EmailPreferenceKey,
): boolean {
  const stored = row?.[key];
  return stored ?? NOTIFICATION_DEFAULTS[key];
}

/** All four switches resolved at once, for the settings UI and the digest. */
export function resolveNotificationPreferences(
  row: NotificationPreferenceRow | null | undefined,
): Record<EmailPreferenceKey, boolean> {
  return {
    reply_to_me: resolveNotificationPreference(row, "reply_to_me"),
    thread_activity: resolveNotificationPreference(row, "thread_activity"),
    new_blog_post: resolveNotificationPreference(row, "new_blog_post"),
    manager_comment_alerts: resolveNotificationPreference(row, "manager_comment_alerts"),
  };
}

/**
 * Whether a notification of this kind should be EMAILED to this person.
 *
 * Note what this does not do: it never suppresses the in-app row. The switches
 * are about the inbox, so turning email off never costs somebody the record of
 * what happened.
 */
export function shouldEmail(
  row: NotificationPreferenceRow | null | undefined,
  kind: NotificationKind,
  opts: { isManager?: boolean } = {},
): boolean {
  const key = preferenceForKind[kind];
  // A manager alert reaching somebody who is no longer a manager is a leak of
  // moderation traffic, so the role is re-checked at send time rather than
  // trusted from whenever the row was written.
  if (key === "manager_comment_alerts" && !opts.isManager) return false;
  return resolveNotificationPreference(row, key);
}

/** An activity row, as the page and the digest read it. */
export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string;
  read_at: string | null;
  created_at: string;
};

/**
 * The one number in the sidebar: open attention items plus unread activity.
 *
 * Attention items count even though they can never be marked read. That is
 * deliberate. They are the things most worth acting on, and a badge that went
 * quiet while the club had no sellable training dates would be worse than no
 * badge at all.
 */
export function badgeCount(
  attention: ManagerNotification[],
  items: Pick<NotificationItem, "read_at">[],
): number {
  return attention.length + items.filter((i) => i.read_at === null).length;
}

/** A digest email, grouped so each section can have its own heading. */
export type DigestSections = {
  replies: NotificationItem[];
  threads: NotificationItem[];
  posts: NotificationItem[];
  moderation: NotificationItem[];
};

/**
 * Split a person's pending rows into the sections a digest email renders, and
 * drop the kinds they have switched off.
 *
 * `reply` rows appear here only when they were never sent instantly (no API
 * key configured, a failed send). A reply that already went out is stamped
 * `emailed_at` at send time and never reaches the digest, so nobody is told
 * twice about the same comment.
 */
export function digestSections(
  rows: NotificationItem[],
  prefs: NotificationPreferenceRow | null | undefined,
  opts: { isManager?: boolean } = {},
): DigestSections {
  const allowed = rows.filter((r) => shouldEmail(prefs, r.kind, opts));
  return {
    replies: allowed.filter((r) => r.kind === "reply"),
    threads: allowed.filter((r) => r.kind === "thread_activity"),
    posts: allowed.filter((r) => r.kind === "new_blog_post"),
    moderation: allowed.filter((r) => r.kind === "blog_comment" || r.kind === "kb_comment"),
  };
}

/**
 * A pending row as the digest picks it up: the item, plus who it is about and
 * what event it is about.
 *
 * `user_id` and `subject_id` are not on `NotificationItem` because nothing that
 * RENDERS an item needs them. They matter only while a household's rows are
 * being merged, which is what the two fields below are for.
 */
export type DigestCandidate = NotificationItem & { user_id: string; subject_id: string };

/**
 * One household's pending rows, as the single email about them should read.
 *
 * A family shares an inbox, so a parent with three children gets ONE digest
 * rather than four. That merge has a trap in it, and this is the function that
 * closes it: `notifyNewBlogPost` writes a row for every person with a club
 * record, children included, so a post announced to a family of four produces
 * four rows carrying the same title and the same link. Concatenated, the parent
 * opens one email that says "New post: X" four times and cannot tell whether
 * that is four posts or one.
 *
 * So rows are folded on `(kind, subject_id)`, which is the club's own name for
 * "the same event": it is the unique index the `notifications` table already
 * carries per person, and lifting it to the household is exactly the same
 * statement one level up. The earliest row wins, so the merged list keeps the
 * created_at order it arrived in.
 *
 * ⚠️ This decides what is SHOWN, never what is stamped. Every row that went in
 * is still owed an `emailed_at`, including the ones folded away here, or
 * tomorrow's run reads them again and mails the family a second copy.
 */
export function mergeHouseholdItems(rows: DigestCandidate[]): NotificationItem[] {
  const seen = new Set<string>();
  const merged: NotificationItem[] = [];
  for (const row of rows) {
    const key = `${row.kind}:${row.subject_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      href: row.href,
      read_at: row.read_at,
      created_at: row.created_at,
    });
  }
  return merged;
}

/** Whether a digest has anything in it. An empty one is not sent. */
export function hasDigestContent(sections: DigestSections): boolean {
  return (
    sections.replies.length > 0 ||
    sections.threads.length > 0 ||
    sections.posts.length > 0 ||
    sections.moderation.length > 0
  );
}

/** How many items a digest covers, for the subject line and the logs. */
export function digestItemCount(sections: DigestSections): number {
  return (
    sections.replies.length +
    sections.threads.length +
    sections.posts.length +
    sections.moderation.length
  );
}

/**
 * The subject line. Plain and countable rather than clever: this arrives every
 * day, so the useful thing is being able to tell at a glance whether it is
 * worth opening.
 */
export function digestSubject(siteName: string, sections: DigestSections): string {
  const n = digestItemCount(sections);
  return n === 1 ? `1 new thing at ${siteName}` : `${n} new things at ${siteName}`;
}

/**
 * The recipients of a thread-activity notification: everyone who has taken part
 * except the person who just wrote, and except anyone already being told about
 * this same comment as a direct reply. Without that second exclusion the author
 * of the parent comment gets both an instant reply email and a line in their
 * digest about the same words.
 */
export function threadActivityRecipients(
  participantIds: string[],
  opts: { actorId: string; directReplyToId?: string | null },
): string[] {
  const excluded = new Set([opts.actorId]);
  if (opts.directReplyToId) excluded.add(opts.directReplyToId);
  return [...new Set(participantIds)].filter((id) => !excluded.has(id));
}

/** Where a blog comment lives, for a notification's `href`. */
export function blogCommentHref(slug: string, commentId: string): string {
  return `/blog/${slug}#comment-${commentId}`;
}

/** Where a knowledge base comment lives, for a notification's `href`. */
export function kbAnnotationHref(slug: string, annotationId: string): string {
  return `/kb/${slug}#comment-${annotationId}`;
}

/** Where a published post lives. */
export function blogPostHref(slug: string): string {
  return `/blog/${slug}`;
}

/**
 * A comment reduced to a preview line for a notification's body.
 *
 * Collapses whitespace and cuts at a word boundary, the same shape
 * `deriveExcerpt` gives a post. Comments are plain text (see docs/blog.md), so
 * there is no markup to strip.
 */
export function commentPreview(body: string, max = 160): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}
