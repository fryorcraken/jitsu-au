-- Public blog: posts written by managers, read by anyone.
--
-- Only a manager can write a post today (finer-grained authoring permissions
-- are a later step). A post is a draft until a manager publishes it; only
-- published posts are visible to the public. Body is Markdown (`react-markdown`
-- already renders it elsewhere, e.g. the waiver template); a `[[video:<url>]]`
-- line in the body is swapped for an embedded player by the renderer, the same
-- way a photo is a plain Markdown image pointing at the `blog-media` bucket.

CREATE TABLE public.blog_posts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 1 AND 200),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  excerpt TEXT CHECK (excerpt IS NULL OR char_length(excerpt) <= 500),
  body_md TEXT NOT NULL CHECK (char_length(body_md) BETWEEN 1 AND 50000),
  cover_image_path TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The public list: newest published post first.
CREATE INDEX blog_posts_published_idx
  ON public.blog_posts (published_at DESC)
  WHERE status = 'published';

-- ---------- Grants ----------
-- Supabase's bootstrap grants ALL on every new table in `public` to anon and
-- authenticated, and GRANT cannot narrow that — only REVOKE can, so the REVOKE
-- comes first (docs/database-changes.md).
REVOKE ALL ON public.blog_posts FROM anon, authenticated;
-- Published posts are public marketing content, read through the same "public
-- funnel" server-function shape as waiver_templates: a server function builds
-- its own anon-key client with no user session, so PostgREST resolves it to
-- `anon` and needs a real grant (see supabase/lint/client-grants-expected.txt).
GRANT SELECT ON public.blog_posts TO anon, authenticated;
GRANT ALL ON public.blog_posts TO service_role;

ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read published posts" ON public.blog_posts
  FOR SELECT USING (status = 'published');
CREATE POLICY "Managers can read all posts" ON public.blog_posts
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));

-- Writes run through server functions on the service role (author validation,
-- slug collision handling, cover-image cleanup on delete), so there is no
-- client write grant. These policies are defence in depth for the day one is
-- added, same idiom as event_rsvps / manager_api_tokens.
CREATE POLICY "Managers can create posts" ON public.blog_posts
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can update posts" ON public.blog_posts
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can delete posts" ON public.blog_posts
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'manager'));

NOTIFY pgrst, 'reload schema';
