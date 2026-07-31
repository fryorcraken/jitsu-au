// Blog comments: any signed-in person may comment or reply — membership
// status irrelevant, the same rule as calendar RSVPs — and upvote a comment
// once (no downvote). Managers moderate by hiding a comment, and in the
// extreme case block a person from commenting anywhere on the blog. See
// docs/blog.md.
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  blockCommenterSchema,
  blogCommentSchema,
  commentDisplayName,
  listBlogCommentsSchema,
  listCommentsForModerationSchema,
  setCommentVisibilitySchema,
  toggleUpvoteSchema,
  unblockCommenterSchema,
} from "@/lib/validation";
import { userEmails } from "@/lib/supabase-rpc";

/** Fail unless the caller holds the manager role. */
async function requireManager(context: {
  supabase: SupabaseClient<Database>;
  userId: string;
}): Promise<void> {
  const { data: isMgr, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "manager",
  });
  if (error) throw new Error(error.message);
  if (!isMgr) throw new Error("Forbidden");
}

// ---- Core writes (plain functions, testable without a Start context) ----
//
// Same reasoning as `resolvePostSlug` in blog.functions.ts / `signStoredPdf` in
// waiver.functions.ts: a `createServerFn` handler dies on "No Start context
// found in AsyncLocalStorage" when called from the test runner, so the rules
// worth pinning live in plain functions that take their client as a parameter.

/**
 * Count replies per parent comment id, for surfacing "hiding this also
 * removes N replies" warnings in the moderation UI (nesting is one level, so
 * every reply's `parent_comment_id` is a top-level comment's id).
 */
export function countRepliesByParent(
  comments: { id: string; parent_comment_id: string | null }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of comments) {
    if (c.parent_comment_id) {
      counts.set(c.parent_comment_id, (counts.get(c.parent_comment_id) ?? 0) + 1);
    }
  }
  return counts;
}

export type InsertBlogCommentInput = {
  postId: string;
  userId: string;
  parentCommentId?: string;
  body: string;
};

/**
 * Insert a comment or reply, enforcing what RLS cannot express: the post must
 * be published, the commenter must not be blocked, and a reply's own parent
 * must itself be top-level (nesting is one level).
 */
export async function insertBlogComment(
  admin: SupabaseClient<Database>,
  input: InsertBlogCommentInput,
): Promise<{ id: string }> {
  const { data: post, error: postErr } = await admin
    .from("blog_posts")
    .select("id, status")
    .eq("id", input.postId)
    .maybeSingle();
  if (postErr) throw new Error(postErr.message);
  if (!post || post.status !== "published") throw new Error("This post isn't open for comments.");

  const { data: blocked, error: blockedErr } = await admin
    .from("blog_blocked_commenters")
    .select("user_id")
    .eq("user_id", input.userId)
    .maybeSingle();
  if (blockedErr) throw new Error(blockedErr.message);
  if (blocked) throw new Error("You're not able to comment right now.");

  if (input.parentCommentId) {
    const { data: parent, error: parentErr } = await admin
      .from("blog_comments")
      .select("id, post_id, parent_comment_id")
      .eq("id", input.parentCommentId)
      .maybeSingle();
    if (parentErr) throw new Error(parentErr.message);
    if (!parent || parent.post_id !== input.postId)
      throw new Error("That comment no longer exists.");
    if (parent.parent_comment_id) throw new Error("You can only reply to a top-level comment.");
  }

  const { data: row, error } = await admin
    .from("blog_comments")
    .insert({
      post_id: input.postId,
      user_id: input.userId,
      parent_comment_id: input.parentCommentId ?? null,
      body: input.body,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return row;
}

export type ToggleUpvoteResult = { upvoted: boolean; count: number };

/** Toggle the caller's upvote on a comment: add it if absent, remove it if present. */
export async function toggleCommentUpvoteRow(
  admin: SupabaseClient<Database>,
  input: { commentId: string; userId: string },
): Promise<ToggleUpvoteResult> {
  const { data: existing, error: existingErr } = await admin
    .from("blog_comment_upvotes")
    .select("user_id")
    .eq("comment_id", input.commentId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (existingErr) throw new Error(existingErr.message);

  if (existing) {
    const { error } = await admin
      .from("blog_comment_upvotes")
      .delete()
      .eq("comment_id", input.commentId)
      .eq("user_id", input.userId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await admin
      .from("blog_comment_upvotes")
      .insert({ comment_id: input.commentId, user_id: input.userId });
    if (error) throw new Error(error.message);
  }

  const { count, error: countErr } = await admin
    .from("blog_comment_upvotes")
    .select("*", { count: "exact", head: true })
    .eq("comment_id", input.commentId);
  if (countErr) throw new Error(countErr.message);
  return { upvoted: !existing, count: count ?? 0 };
}

// ---- Public: read comments ----
//
// Runs on the service role rather than the anon "public funnel" pattern
// (unlike blog.functions.ts' public reads): showing a comment needs the
// commenter's profile (for their display name) and an upvote count, both
// joins `anon` has no grant to make. The handler filters exactly what RLS
// would have (post published, comment visible) since the service role
// bypasses RLS.

export const listComments = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => listBlogCommentsSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: post } = await supabaseAdmin
      .from("blog_posts")
      .select("id, status")
      .eq("id", data.post_id)
      .maybeSingle();
    if (!post || post.status !== "published") return [];

    const { data: rows, error } = await supabaseAdmin
      .from("blog_comments")
      .select("id, parent_comment_id, body, created_at, user_id")
      .eq("post_id", data.post_id)
      .eq("status", "visible")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const comments = rows ?? [];
    if (comments.length === 0) return [];

    const userIds = [...new Set(comments.map((c) => c.user_id))];
    const [{ data: profiles }, { data: upvotes }] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("user_id, first_name, preferred_name, last_name, display_name")
        .in("user_id", userIds),
      supabaseAdmin
        .from("blog_comment_upvotes")
        .select("comment_id")
        .in(
          "comment_id",
          comments.map((c) => c.id),
        ),
    ]);
    const profileByUser = new Map((profiles ?? []).map((p) => [p.user_id, p]));
    const upvoteCounts = new Map<string, number>();
    for (const u of upvotes ?? [])
      upvoteCounts.set(u.comment_id, (upvoteCounts.get(u.comment_id) ?? 0) + 1);

    return comments.map((c) => ({
      id: c.id,
      parent_comment_id: c.parent_comment_id,
      body: c.body,
      created_at: c.created_at,
      author_name: commentDisplayName(profileByUser.get(c.user_id) ?? {}),
      upvote_count: upvoteCounts.get(c.id) ?? 0,
    }));
  });

/** The signed-in caller's own upvotes, so the UI can show a comment's upvote
 * button as already pressed. Uses the caller-scoped client, narrowed by RLS to
 * their own rows (`blog_comment_upvotes:authenticated:SELECT`). */
export const getMyCommentUpvotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("blog_comment_upvotes")
      .select("comment_id")
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => r.comment_id);
  });

// ---- Any signed-in person: comment, reply, upvote ----

export const postComment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => blogCommentSchema.parse(d))
  .handler(async ({ data, context }) => {
    if (data.hp) return { id: "" };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return insertBlogComment(supabaseAdmin, {
      postId: data.post_id,
      userId: context.userId,
      parentCommentId: data.parent_comment_id,
      body: data.body,
    });
  });

export const toggleCommentUpvote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => toggleUpvoteSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return toggleCommentUpvoteRow(supabaseAdmin, {
      commentId: data.comment_id,
      userId: context.userId,
    });
  });

// ---- Manager: moderation ----

export const listCommentsForModeration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listCommentsForModerationSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let query = supabaseAdmin
      .from("blog_comments")
      .select("id, post_id, user_id, parent_comment_id, body, status, hidden_reason, created_at")
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.post_id) query = query.eq("post_id", data.post_id);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    const comments = rows ?? [];
    if (comments.length === 0) return [];

    const postIds = [...new Set(comments.map((c) => c.post_id))];
    const userIds = [...new Set(comments.map((c) => c.user_id))];
    const [{ data: posts }, { data: profiles }, { data: emails }] = await Promise.all([
      supabaseAdmin.from("blog_posts").select("id, title, slug").in("id", postIds),
      supabaseAdmin
        .from("profiles")
        .select("user_id, first_name, preferred_name, last_name, display_name")
        .in("user_id", userIds),
      userEmails(supabaseAdmin, userIds),
    ]);
    const postById = new Map((posts ?? []).map((p) => [p.id, p]));
    const profileByUser = new Map((profiles ?? []).map((p) => [p.user_id, p]));
    const emailByUser = new Map((emails ?? []).map((e) => [e.user_id, e.email]));

    return comments.map((c) => ({
      id: c.id,
      post_id: c.post_id,
      post_title: postById.get(c.post_id)?.title ?? "(deleted post)",
      post_slug: postById.get(c.post_id)?.slug ?? null,
      user_id: c.user_id,
      author_name: commentDisplayName(profileByUser.get(c.user_id) ?? {}),
      author_email: emailByUser.get(c.user_id) ?? null,
      parent_comment_id: c.parent_comment_id,
      body: c.body,
      status: c.status,
      hidden_reason: c.hidden_reason,
      created_at: c.created_at,
    }));
  });

export const setCommentVisibility = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setCommentVisibilitySchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const hiding = data.status === "hidden";
    const { error } = await supabaseAdmin
      .from("blog_comments")
      .update({
        status: data.status,
        hidden_by: hiding ? context.userId : null,
        hidden_at: hiding ? new Date().toISOString() : null,
        hidden_reason: hiding ? data.reason || null : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const blockCommenter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => blockCommenterSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("blog_blocked_commenters").upsert({
      user_id: data.user_id,
      blocked_by: context.userId,
      reason: data.reason || null,
      blocked_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const unblockCommenter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => unblockCommenterSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("blog_blocked_commenters")
      .delete()
      .eq("user_id", data.user_id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const listBlockedCommenters = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("blog_blocked_commenters")
      .select("user_id, blocked_at, reason")
      .order("blocked_at", { ascending: false });
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (rows.length === 0) return [];

    const userIds = rows.map((r) => r.user_id);
    const [{ data: profiles }, { data: emails }] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("user_id, first_name, preferred_name, last_name, display_name")
        .in("user_id", userIds),
      userEmails(supabaseAdmin, userIds),
    ]);
    const profileByUser = new Map((profiles ?? []).map((p) => [p.user_id, p]));
    const emailByUser = new Map((emails ?? []).map((e) => [e.user_id, e.email]));

    return rows.map((r) => ({
      user_id: r.user_id,
      name: commentDisplayName(profileByUser.get(r.user_id) ?? {}),
      email: emailByUser.get(r.user_id) ?? null,
      blocked_at: r.blocked_at,
      reason: r.reason,
    }));
  });
