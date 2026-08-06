// Blog posts: written by managers only (finer-grained authoring permissions
// are a later step), read by anyone. See docs/blog.md.
import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  blogPostSchema,
  blogPostSlugSchema,
  type BlogPostStatus,
  deleteBlogPostSchema,
  getBlogPostForEditSchema,
  listBlogPostsSchema,
  uploadBlogImageSchema,
} from "@/lib/validation";
import { defaultBlogSlug, uniqueSlug } from "@/lib/slug";
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

export const listAllBlogPosts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("blog_posts")
      .select("id, slug, title, status, published_at, created_at, updated_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getBlogPostForEdit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getBlogPostForEditSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("blog_posts")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("That post no longer exists.");
    return { ...row, cover_image_url: coverImageUrl(supabaseAdmin, row.cover_image_path) };
  });

export const createBlogPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => blogPostSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const slug = await resolvePostSlug(supabaseAdmin, data.title, data.slug);
    const { data: row, error } = await supabaseAdmin
      .from("blog_posts")
      .insert({
        slug,
        title: data.title,
        excerpt: data.excerpt || null,
        body_md: data.body_md,
        cover_image_path: data.cover_image_path || null,
        status: data.status,
        author_id: context.userId,
        published_at: data.status === "published" ? new Date().toISOString() : null,
      })
      .select("id, slug")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateBlogPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => blogPostSchema.parse(d))
  .handler(async ({ data, context }) => {
    if (!data.id) throw new Error("Missing post id.");
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("blog_posts")
      .select("status, published_at")
      .eq("id", data.id)
      .maybeSingle();
    if (existingErr) throw new Error(existingErr.message);
    if (!existing) throw new Error("That post no longer exists.");
    const slug = await resolvePostSlug(supabaseAdmin, data.title, data.slug, data.id);
    const publishedAt = resolvePublishedAt(
      existing.published_at,
      data.status,
      new Date().toISOString(),
    );
    const { error } = await supabaseAdmin
      .from("blog_posts")
      .update({
        slug,
        title: data.title,
        excerpt: data.excerpt || null,
        body_md: data.body_md,
        cover_image_path: data.cover_image_path || null,
        status: data.status,
        published_at: publishedAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const, slug };
  });

export const deleteBlogPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => deleteBlogPostSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("blog_posts")
      .select("cover_image_path")
      .eq("id", data.id)
      .maybeSingle();
    const { error } = await supabaseAdmin.from("blog_posts").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    // Best-effort: the post row is gone either way, so a storage cleanup
    // failure must not be reported as the delete having failed.
    if (row?.cover_image_path) {
      await supabaseAdmin.storage
        .from(BUCKET)
        .remove([row.cover_image_path])
        .catch(() => {});
    }
    return { ok: true as const };
  });

export const uploadBlogImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => uploadBlogImageSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const bytes = decodeBase64(data.data);
    const safeName = data.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${data.post_id || "drafts"}/${crypto.randomUUID()}-${safeName}`;
    const { error } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: data.type, upsert: false });
    if (error) throw new Error(error.message);
    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
    return { path, url: pub.publicUrl };
  });
