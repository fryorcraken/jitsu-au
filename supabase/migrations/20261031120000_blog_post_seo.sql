-- A blog post's own search-engine title and description.
--
-- Until now a post's page told search engines "<title> | UTS Jitsu Blog" and
-- its excerpt, with no way to say anything different. Both are written for
-- somebody already on the blog: the excerpt is the line under the title on the
-- list, and the title is the headline. What fits a search result (about 60
-- characters of title, about 155 of description) is often not either. These two
-- columns let a manager, or the manager agent API, set them separately:
--
--   seo_title        The page's <title>, og:title and twitter:title, used as
--                    written. NULL means "<title> | UTS Jitsu Blog".
--   seo_description  The meta, og: and twitter: description. NULL means the
--                    excerpt, as before.
--
-- NULL is the default and the only "not set" value: the app stores a blank
-- field as NULL, and the CHECKs refuse an empty string so there is one way to
-- say it. Neither is derived at save time, unlike the excerpt, so a post left
-- on the defaults follows a later change to its title or excerpt by itself.
--
-- The limits are hard ceilings, not the advice: the editor shows the length
-- search engines usually display, and this only stops something that could
-- never be a title or a description being stored.
--
-- Additive (the EXPAND half), so per docs/database-changes.md this goes live
-- BEFORE the code that reads and writes the columns. Applying it changes
-- nothing anybody sees: every existing post gets NULL, which is what it shows
-- today.
--
-- Grants: none. `blog_posts` already grants SELECT on the whole table to anon
-- and authenticated (20260731100000), which a new column joins, and which is
-- right for it: both are published on the post's public page anyway. RLS still
-- limits anon to published posts. client-grants-expected.txt is unchanged.

ALTER TABLE public.blog_posts
  ADD COLUMN seo_title TEXT
    CHECK (seo_title IS NULL OR char_length(seo_title) BETWEEN 1 AND 100),
  ADD COLUMN seo_description TEXT
    CHECK (seo_description IS NULL OR char_length(seo_description) BETWEEN 1 AND 300);

NOTIFY pgrst, 'reload schema';
