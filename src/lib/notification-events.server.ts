// Server-only: works out WHO hears about a comment or a post, and writes the
// notifications. Delivery lives in `notification-email.server.ts`; this module
// is the recipient rules.
//
// Split out from the sender so the two questions stay separable: "who should be
// told" is where the privacy guards live, and "how does it reach them" is where
// the transport does. Both are lazy-imported from server-function handlers, and
// neither may ever reach the client bundle.
//
// Everything here is best-effort and swallows its own failures. A notification
// must never be able to fail the comment somebody just posted.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  blogCommentHref,
  blogPostHref,
  commentPreview,
  kbAnnotationHref,
  threadActivityRecipients,
} from "@/lib/notifications";
import { commentDisplayName } from "@/lib/validation";

type AdminClient = SupabaseClient<Database>;

/** Everyone holding the manager role, for the moderation alerts. */
async function managerIds(db: AdminClient): Promise<string[]> {
  const { data, error } = await db.from("user_roles").select("user_id").eq("role", "manager");
  if (error || !data) return [];
  return [...new Set(data.map((r) => r.user_id))];
}

/** The commenter's public display name. Never the legal name: this is quoted
 * into an email that goes to other members (see docs/blog.md rule 10). */
async function displayNameFor(db: AdminClient, userId: string): Promise<string> {
  const { data } = await db
    .from("profiles")
    .select("first_name, last_name, preferred_name, display_name")
    .eq("user_id", userId)
    .maybeSingle();
  return data ? commentDisplayName(data) : "Someone at the club";
}

/** Drop anybody with no `profiles` row. `notifications.user_id` is a foreign key
 * to it, so an insert for a role-holder whose profile was deleted would fail the
 * whole batch and lose everybody else's notification with it. */
async function withProfiles(db: AdminClient, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const { data, error } = await db.from("profiles").select("user_id").in("user_id", userIds);
  if (error || !data) return [];
  const known = new Set(data.map((p) => p.user_id));
  return userIds.filter((id) => known.has(id));
}

/**
 * Somebody commented on a blog post.
 *
 * Three audiences, in order of how personal they are: the person replied to
 * (instant email), everybody else in the thread, and the managers.
 */
export async function notifyBlogComment(
  db: AdminClient,
  input: {
    commentId: string;
    postId: string;
    actorId: string;
    parentCommentId?: string | null;
    body: string;
  },
): Promise<void> {
  const { writeNotifications, sendReplyNotification } =
    await import("@/lib/notification-email.server");

  const { data: post } = await db
    .from("blog_posts")
    .select("slug, title, status")
    .eq("id", input.postId)
    .maybeSingle();
  // A comment on an unpublished post notifies nobody. `postComment` already
  // refuses one, so this is belt and braces.
  if (!post || post.status !== "published") return;

  const authorName = await displayNameFor(db, input.actorId);
  const preview = commentPreview(input.body);
  const href = blogCommentHref(post.slug, input.commentId);
  const context = `your comment on ${post.title}`;

  // ---- The person replied to ----
  let repliedToId: string | null = null;
  if (input.parentCommentId) {
    const { data: parent } = await db
      .from("blog_comments")
      .select("user_id, status")
      .eq("id", input.parentCommentId)
      .maybeSingle();
    // A hidden parent notifies nobody: its author is being moderated, and
    // telling them their hidden comment got a reply undoes that quietly.
    if (parent && parent.status === "visible" && parent.user_id !== input.actorId) {
      repliedToId = parent.user_id;
    }
  }

  // ---- Everybody else in the thread ----
  const { data: participants } = await db
    .from("blog_comments")
    .select("user_id")
    .eq("post_id", input.postId)
    .eq("status", "visible");
  const others = threadActivityRecipients(
    (participants ?? []).map((p) => p.user_id),
    { actorId: input.actorId, directReplyToId: repliedToId },
  );

  // ---- Managers ----
  const managers = (await managerIds(db)).filter((id) => id !== input.actorId);

  const [replyTo, threadIds, managerIdsWithProfiles] = await Promise.all([
    repliedToId ? withProfiles(db, [repliedToId]) : Promise.resolve([]),
    withProfiles(db, others),
    withProfiles(db, managers),
  ]);

  const written = await writeNotifications(db, [
    ...replyTo.map((userId) => ({
      userId,
      kind: "reply" as const,
      subjectType: "blog_comment" as const,
      subjectId: input.commentId,
      actorId: input.actorId,
      title: `${authorName} replied to you`,
      body: preview,
      href,
    })),
    ...threadIds.map((userId) => ({
      userId,
      kind: "thread_activity" as const,
      subjectType: "blog_comment" as const,
      subjectId: input.commentId,
      actorId: input.actorId,
      title: `${authorName} commented on ${post.title}`,
      body: preview,
      href,
    })),
    ...managerIdsWithProfiles.map((userId) => ({
      userId,
      kind: "blog_comment" as const,
      subjectType: "blog_comment" as const,
      subjectId: input.commentId,
      actorId: input.actorId,
      title: `New blog comment from ${authorName}`,
      body: preview,
      href,
    })),
  ]);

  // Only the reply is instant. Everything else waits for the daily digest.
  const replyRow = written.find((r) => r.kind === "reply");
  if (replyRow) {
    await sendReplyNotification(db, {
      notificationId: replyRow.id,
      recipientId: replyRow.user_id,
      authorName,
      preview,
      href,
      context,
    });
  }
}

/**
 * Somebody commented on a knowledge base article.
 *
 * The privacy rules here are the strict ones. A PRIVATE note notifies nobody,
 * managers included: it is readable by its author alone, and a notification
 * carrying its text would be the leak. And because an article's visibility can
 * narrow after somebody commented, every recipient is re-checked against the
 * article as it stands NOW, not as it stood when they took part.
 */
export async function notifyKbAnnotation(
  db: AdminClient,
  input: {
    annotationId: string;
    articleId: string;
    actorId: string;
    parentId?: string | null;
    body: string;
    visibility: string;
  },
): Promise<void> {
  // The guard the whole feature rests on. `createAnnotation` already refuses a
  // private reply, so this is belt and braces, but a private note's text must
  // never leave the database and this is the last place to stop it.
  if (input.visibility !== "shared") return;

  const { writeNotifications, sendReplyNotification } =
    await import("@/lib/notification-email.server");

  const { data: article } = await db
    .from("kb_articles")
    .select("slug, visibility")
    .eq("id", input.articleId)
    .maybeSingle();
  if (!article) return;

  const { data: version } = await db
    .from("kb_article_versions")
    .select("title")
    .eq("article_id", input.articleId)
    .eq("is_current", true)
    .maybeSingle();
  const articleTitle = version?.title ?? article.slug;

  const authorName = await displayNameFor(db, input.actorId);
  const preview = commentPreview(input.body);
  const href = kbAnnotationHref(article.slug, input.annotationId);
  const context = `your comment on ${articleTitle}`;

  // ---- The person replied to ----
  let repliedToId: string | null = null;
  let threadRootId = input.annotationId;
  if (input.parentId) {
    const { data: parent } = await db
      .from("kb_annotations")
      .select("user_id, visibility")
      .eq("id", input.parentId)
      .maybeSingle();
    // Replying to a private note is already refused upstream. Re-checked here
    // because "which rows may be quoted" is this module's job.
    if (parent && parent.visibility === "shared" && parent.user_id !== input.actorId) {
      repliedToId = parent.user_id;
    }
    threadRootId = input.parentId;
  }

  // ---- Everybody else on the thread ----
  const { data: thread } = await db
    .from("kb_annotations")
    .select("user_id, id, parent_id, visibility")
    .eq("article_id", input.articleId)
    .eq("visibility", "shared");
  const participants = (thread ?? [])
    .filter((a) => a.id === threadRootId || a.parent_id === threadRootId)
    .map((a) => a.user_id);
  const others = threadActivityRecipients(participants, {
    actorId: input.actorId,
    directReplyToId: repliedToId,
  });

  const managers = (await managerIds(db)).filter((id) => id !== input.actorId);

  // The visibility re-check. A `managers` article must only ever reach managers,
  // even if a member commented on it back when it was `members`.
  const managerSet = new Set(managers);
  const admitted = (ids: string[]) =>
    article.visibility === "managers" ? ids.filter((id) => managerSet.has(id)) : ids;

  const [replyTo, threadIds, managerIdsWithProfiles] = await Promise.all([
    withProfiles(db, admitted(repliedToId ? [repliedToId] : [])),
    withProfiles(db, admitted(others)),
    withProfiles(db, managers),
  ]);

  const written = await writeNotifications(db, [
    ...replyTo.map((userId) => ({
      userId,
      kind: "reply" as const,
      subjectType: "kb_annotation" as const,
      subjectId: input.annotationId,
      actorId: input.actorId,
      title: `${authorName} replied to you`,
      body: preview,
      href,
    })),
    ...threadIds.map((userId) => ({
      userId,
      kind: "thread_activity" as const,
      subjectType: "kb_annotation" as const,
      subjectId: input.annotationId,
      actorId: input.actorId,
      title: `${authorName} commented on ${articleTitle}`,
      body: preview,
      href,
    })),
    ...managerIdsWithProfiles.map((userId) => ({
      userId,
      kind: "kb_comment" as const,
      subjectType: "kb_annotation" as const,
      subjectId: input.annotationId,
      actorId: input.actorId,
      title: `New knowledge base comment from ${authorName}`,
      body: preview,
      href,
    })),
  ]);

  const replyRow = written.find((r) => r.kind === "reply");
  if (replyRow) {
    await sendReplyNotification(db, {
      notificationId: replyRow.id,
      recipientId: replyRow.user_id,
      authorName,
      preview,
      href,
      context,
    });
  }
}

/**
 * A post went live.
 *
 * Fanned out to everybody with a club record, and safe to call again: the
 * unique index on `(user_id, kind, subject_id)` absorbs the repeat, which is
 * what makes an unpublish/republish round trip announce the post exactly once.
 * That is also why `blog_posts` needs no `announced_at` column.
 *
 * Note this writes a row for everybody regardless of their email switch. The
 * switches govern the inbox, not the page: somebody who does not want the
 * announcement emailed still sees it in their notifications, and the digest is
 * where the preference is applied.
 */
export async function notifyNewBlogPost(
  db: AdminClient,
  input: { postId: string; slug: string; title: string; actorId?: string | null },
): Promise<void> {
  const { writeNotifications } = await import("@/lib/notification-email.server");

  const { data: people, error } = await db.from("profiles").select("user_id");
  if (error || !people) return;

  await writeNotifications(
    db,
    people
      .map((p) => p.user_id)
      .filter((userId) => userId !== input.actorId)
      .map((userId) => ({
        userId,
        kind: "new_blog_post" as const,
        subjectType: "blog_post" as const,
        subjectId: input.postId,
        actorId: input.actorId ?? null,
        title: `New post: ${input.title}`,
        body: null,
        href: blogPostHref(input.slug),
      })),
  );
}
