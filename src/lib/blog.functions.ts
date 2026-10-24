// Blog posts: written by managers only (finer-grained authoring permissions
// are a later step), read by anyone. See docs/blog.md.
import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  blogPostSchema,
  blogPostSlugSchema,
  type BlogImageMimeType,
  type BlogPostInput,
  type BlogPostStatus,
  deleteBlogPostSchema,
  getBlogPostForEditSchema,
  listBlogPostsSchema,
  uploadBlogImageSchema,
} from "@/lib/validation";
import { defaultBlogSlug, uniqueSlug } from "@/lib/slug";
import { deriveExcerpt } from "@/lib/blog-content";
import { decodeBase64 } from "@/lib/waiver-scan";

const BUCKET = "blog-media";
const POSTS_PAGE_SIZE = 10;

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

/**
 * Read the public blog through the "public funnel" anon client: no user
 * session, so PostgREST resolves it to `anon`, which only ever sees
 * `status = 'published'` (RLS + the matching grant in
 * supabase/lint/client-grants-expected.txt). Same shape as
 * `getCurrentWaiverTemplate` in waiver.functions.ts.
 */
function serverSupabase() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`)
          h.delete("Authorization");
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

/**
 * Resolve the slug a post will be saved under: the manager's own, or one
 * derived from the title and today's date (`defaultBlogSlug`), made unique
 * against every OTHER post's slug that shares the same base (so
 * "2026-08-06-hello-world" collides into "...-2", not a database error).
 * Exported for its test — plain, taking the admin client and `now` as
 * parameters, unlike the `createServerFn` handlers around it.
 */
export async function resolvePostSlug(
  admin: SupabaseClient<Database>,
  title: string,
  provided: string | undefined,
  excludeId?: string,
  now: Date = new Date(),
): Promise<string> {
  const base = (provided || "").trim() || defaultBlogSlug(title, now);
  if (!base) {
    throw new Error("Could not turn that title into a URL. Set a URL slug by hand.");
  }
  let query = admin.from("blog_posts").select("slug").ilike("slug", `${base}%`);
  if (excludeId) query = query.neq("id", excludeId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const taken = new Set((data ?? []).map((r) => r.slug));
  return uniqueSlug(base, taken);
}

/** The bucket is public, so `getPublicUrl` is a pure string build — no
 * network call — and works on any client, including the anon one. */
function coverImageUrl(supabase: SupabaseClient<Database>, path: string | null): string | null {
  if (!path) return null;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * Resolve the `published_at` to save on an update: set the first time a post
 * goes live, then kept forever — including when the post is taken back to
 * draft. Clearing it on unpublish would re-date the post to "now" the next
 * time it's republished, silently reordering it to the top of the public list
 * and losing the original publish date. `status` alone already governs public
 * visibility, so `published_at` is free to just mean "first went live",
 * permanently. Exported for its test — plain, no server context needed.
 */
export function resolvePublishedAt(
  existingPublishedAt: string | null,
  newStatus: BlogPostStatus,
  now: string,
): string | null {
  return existingPublishedAt ?? (newStatus === "published" ? now : null);
}

/**
 * The excerpt to store: what the manager typed, or one derived from the body
 * when they left the field blank. The composer previews the same derived text
 * as they write, so what lands in the row is what they were shown.
 *
 * Null when there is nothing to derive either (a post that is only a video,
 * say), which is what the blog list and the post page's meta description
 * already fall back from. Exported for its test — plain, no server context.
 */
export function resolveExcerpt(excerpt: string | undefined, bodyMd: string): string | null {
  return excerpt?.trim() || deriveExcerpt(bodyMd) || null;
}

// ---- Public: published posts ----

export const listPublishedBlogPosts = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => listBlogPostsSchema.parse(d))
  .handler(async ({ data }) => {
    const supabase = serverSupabase();
    const from = (data.page - 1) * POSTS_PAGE_SIZE;
    const to = from + POSTS_PAGE_SIZE - 1;
    const {
      data: rows,
      error,
      count,
    } = await supabase
      .from("blog_posts")
      .select("id, slug, title, excerpt, cover_image_path, published_at", { count: "exact" })
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .range(from, to);
    if (error) throw new Error(error.message);
    const posts = (rows ?? []).map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      excerpt: r.excerpt,
      published_at: r.published_at,
      cover_image_url: coverImageUrl(supabase, r.cover_image_path),
    }));
    return { posts, total: count ?? 0, page: data.page, pageSize: POSTS_PAGE_SIZE };
  });

export const getBlogPostBySlug = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => blogPostSlugSchema.parse(d))
  .handler(async ({ data }) => {
    const supabase = serverSupabase();
    const { data: row, error } = await supabase
      .from("blog_posts")
      .select("id, slug, title, excerpt, body_md, cover_image_path, published_at")
      .eq("slug", data.slug)
      .eq("status", "published")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return null;
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      body_md: row.body_md,
      published_at: row.published_at,
      cover_image_url: coverImageUrl(supabase, row.cover_image_path),
    };
  });

// ---- Manager: authoring ----
//
// Each write is a plain function taking the service-role client, and the
// server functions below are thin wrappers that check the caller is a manager
// first. The manager agent API (src/lib/manager-agent-actions.ts) calls the
// same functions, so a post saved by an agent and one saved on /manager/blog
// are the same row written the same way: same slug and excerpt resolution,
// same publish date rule, same announcement.

type AdminClient = SupabaseClient<Database>;

/** A post that was asked for by id or slug and is not there. */
export class BlogPostNotFoundError extends Error {
  constructor() {
    super("That post no longer exists.");
    this.name = "BlogPostNotFoundError";
  }
}

/** Every post, any status, newest first. */
export async function listBlogPostRows(admin: AdminClient) {
  const { data, error } = await admin
    .from("blog_posts")
    .select("id, slug, title, status, published_at, created_at, updated_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** One post, any status, by id or by slug. Throws `BlogPostNotFoundError`. */
export async function loadBlogPostRow(admin: AdminClient, key: { id: string } | { slug: string }) {
  const query = admin.from("blog_posts").select("*");
  const { data: row, error } = await (
    "id" in key ? query.eq("id", key.id) : query.eq("slug", key.slug)
  ).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new BlogPostNotFoundError();
  return { ...row, cover_image_url: coverImageUrl(admin, row.cover_image_path) };
}

/** What a save stored, including what the server resolved for the caller. */
export type SavedBlogPost = {
  id: string;
  slug: string;
  excerpt: string | null;
  status: BlogPostStatus;
  published_at: string | null;
  /** True when this save took the post live for the first time and announced it. */
  announced: boolean;
};

export async function createBlogPostRow(
  admin: AdminClient,
  data: BlogPostInput,
  actorId: string,
): Promise<SavedBlogPost> {
  const slug = await resolvePostSlug(admin, data.title, data.slug);
  const excerpt = resolveExcerpt(data.excerpt, data.body_md);
  const publishedAt = data.status === "published" ? new Date().toISOString() : null;
  const { data: row, error } = await admin
    .from("blog_posts")
    .insert({
      slug,
      title: data.title,
      excerpt,
      body_md: data.body_md,
      cover_image_path: data.cover_image_path || null,
      status: data.status,
      author_id: actorId,
      published_at: publishedAt,
    })
    .select("id, slug")
    .single();
  if (error) throw new Error(error.message);
  const announced = data.status === "published";
  if (announced) {
    await announcePost(row.id, row.slug, data.title, actorId);
  }
  return {
    id: row.id,
    slug: row.slug,
    excerpt,
    status: data.status,
    published_at: publishedAt,
    announced,
  };
}

/**
 * Tell everybody a post went live. Best-effort and swallowed: a post is
 * published and must never fail because the announcement did.
 *
 * Safe to call more than once for the same post. The unique index behind
 * `notifications` absorbs the repeat, which is what makes an
 * unpublish/republish round trip announce a post exactly once, and is why
 * `blog_posts` carries no `announced_at` column.
 */
async function announcePost(
  postId: string,
  slug: string,
  title: string,
  actorId: string,
): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { notifyNewBlogPost } = await import("@/lib/notification-events.server");
    await notifyNewBlogPost(supabaseAdmin, { postId, slug, title, actorId });
  } catch (e) {
    console.error("[blog] failed to announce a published post:", e);
  }
}

export async function updateBlogPostRow(
  admin: AdminClient,
  data: BlogPostInput & { id: string },
  actorId: string,
): Promise<SavedBlogPost> {
  const { data: existing, error: existingErr } = await admin
    .from("blog_posts")
    .select("status, published_at")
    .eq("id", data.id)
    .maybeSingle();
  if (existingErr) throw new Error(existingErr.message);
  if (!existing) throw new BlogPostNotFoundError();
  const slug = await resolvePostSlug(admin, data.title, data.slug, data.id);
  const publishedAt = resolvePublishedAt(
    existing.published_at,
    data.status,
    new Date().toISOString(),
  );
  const excerpt = resolveExcerpt(data.excerpt, data.body_md);
  const { error } = await admin
    .from("blog_posts")
    .update({
      slug,
      title: data.title,
      excerpt,
      body_md: data.body_md,
      cover_image_path: data.cover_image_path || null,
      status: data.status,
      published_at: publishedAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.id);
  if (error) throw new Error(error.message);
  // Announce on the transition INTO published, not on every save of a
  // published post: editing a typo is not news. The unique index makes a
  // repeat harmless anyway, so this is about not doing the work rather than
  // about correctness.
  const announced = data.status === "published" && existing.status !== "published";
  if (announced) {
    await announcePost(data.id, slug, data.title, actorId);
  }
  return { id: data.id, slug, excerpt, status: data.status, published_at: publishedAt, announced };
}

/** Delete a post and, best-effort, its cover image. `deleted` is false when there was no such post. */
export async function deleteBlogPostRow(
  admin: AdminClient,
  id: string,
): Promise<{ deleted: boolean }> {
  const { data: row } = await admin
    .from("blog_posts")
    .select("cover_image_path")
    .eq("id", id)
    .maybeSingle();
  const { data: gone, error } = await admin.from("blog_posts").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  // Best-effort: the post row is gone either way, so a storage cleanup
  // failure must not be reported as the delete having failed.
  if (row?.cover_image_path) {
    await admin.storage
      .from(BUCKET)
      .remove([row.cover_image_path])
      .catch(() => {});
  }
  return { deleted: (gone ?? []).length > 0 };
}

/**
 * Put an image in the `blog-media` bucket and return its storage path (what
 * `cover_image_path` takes) and its public address (what a Markdown image in
 * the body points at).
 */
export async function storeBlogImage(
  admin: AdminClient,
  file: { post_id?: string; name: string; type: BlogImageMimeType; bytes: Uint8Array },
): Promise<{ path: string; url: string }> {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${file.post_id || "drafts"}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await admin.storage
    .from(BUCKET)
    .upload(path, file.bytes, { contentType: file.type, upsert: false });
  if (error) throw new Error(error.message);
  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(path);
  return { path, url: pub.publicUrl };
}

export const listAllBlogPosts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return listBlogPostRows(supabaseAdmin);
  });

export const getBlogPostForEdit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getBlogPostForEditSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return loadBlogPostRow(supabaseAdmin, { id: data.id });
  });

export const createBlogPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => blogPostSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const saved = await createBlogPostRow(supabaseAdmin, data, context.userId);
    return { id: saved.id, slug: saved.slug };
  });

export const updateBlogPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => blogPostSchema.parse(d))
  .handler(async ({ data, context }) => {
    if (!data.id) throw new Error("Missing post id.");
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const saved = await updateBlogPostRow(supabaseAdmin, { ...data, id: data.id }, context.userId);
    // `slug` and `excerpt` both come back because the server may have resolved
    // either one (a slug collision, or an excerpt derived from the body): the
    // edit page uses them as the new baseline so the form isn't left reading
    // as dirty, and showing something other than what was stored.
    return { ok: true as const, slug: saved.slug, excerpt: saved.excerpt };
  });

export const deleteBlogPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => deleteBlogPostSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await deleteBlogPostRow(supabaseAdmin, data.id);
    return { ok: true as const };
  });

export const uploadBlogImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => uploadBlogImageSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return storeBlogImage(supabaseAdmin, {
      post_id: data.post_id,
      name: data.name,
      type: data.type,
      bytes: decodeBase64(data.data),
    });
  });
