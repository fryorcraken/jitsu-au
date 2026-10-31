-- What kind of post a blog post is: a timeless article, or a club update.
--
-- Every post so far has been a club update: a session log, the week's news,
-- a grading. They are time-bound, read the week they are written, and sorting
-- them newest first is right. The club now also publishes articles, pieces
-- meant to be read for years, and in a newest-first list an article sinks
-- under the session logs within a few weeks. The public blog keeps articles on
-- top and lists club updates under them, which needs each post to say which it
-- is:
--
--   kind  'article' or 'update'. Chosen by the manager in the editor, or by
--         the manager agent API.
--
-- Additive (the EXPAND half), so per docs/database-changes.md this goes live
-- BEFORE the code that reads and writes the column. Applying it changes
-- nothing anybody sees: the default makes every existing post a club update,
-- which is what all of them are, and the blog list today ignores the column.
--
-- No index: the public list reads published articles (a handful) and pages
-- through published updates by published_at, which the existing partial
-- index on (published_at DESC) WHERE status = 'published' already serves.
--
-- Grants: none. `blog_posts` already grants table-level SELECT to anon and
-- authenticated (20260731100000), which a new column joins, and which is
-- right for it: the kind is shown on the public blog anyway. RLS still limits
-- anon to published posts. client-grants-expected.txt is unchanged.

ALTER TABLE public.blog_posts
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'update'
    CHECK (kind IN ('article', 'update'));

NOTIFY pgrst, 'reload schema';
