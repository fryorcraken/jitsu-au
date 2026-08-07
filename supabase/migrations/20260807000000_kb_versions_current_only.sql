-- Knowledge base: version history is a manager's view, so the RLS policy says so.
--
-- Reported by the Supabase schema review as "kb_article_versions policy does not
-- restrict by article-level access nuances". The signed-in SELECT policy tests
-- only the PARENT ARTICLE's visibility, so it admits every version row of a
-- `members` article: superseded wordings, each version's `change_note`, and the
-- transient `is_current = false` row a save writes before promoting it
-- (`saveKbArticle` in src/lib/kb-admin.ts writes the draft, then promotes, so a
-- failure leaves the previous version live rather than the article with none).
--
-- That is wider than the rule the app itself enforces. Every member-facing read
-- filters `is_current = true` — `getKnowledgeBaseIndex`, `getArticle` and
-- `searchKnowledgeBase` in src/lib/kb.functions.ts — and the one call that
-- returns history, `listArticleVersions`, is manager-gated. Rollback
-- (`promoteArticleVersion`) makes the gap wider than "old wordings": a
-- non-current row can hold text a manager deliberately unpublished.
--
-- NOT AN EXPOSURE TODAY, and this migration does not claim to fix one.
-- `kb_article_versions` grants `anon` and `authenticated` nothing —
-- 20260731140000 revoked the Supabase defaults and never granted back, and
-- supabase/lint/client-grants-expected.txt pins that absence against the live
-- database — so no client role reaches the table through PostgREST and this
-- policy is never evaluated. It is defence in depth, kept for the day a grant is
-- added back, exactly like the calendar's owner-scoped write policies in
-- 20260728120000. A defence-in-depth policy is only worth keeping if it encodes
-- the rule the app enforces; this one did not, so it is restated to the live
-- version and history is left to the manager policy that already covers it.
--
-- SEQUENCING: neither half of the expand/contract rule bites. This narrows a
-- policy no code path evaluates — every read of this table is on the service
-- role, which bypasses RLS — so it can go live before or after any deploy.
--
-- The CO-REQUISITE from 20260731140000 still stands and is worth restating,
-- because the sub-select below is the thing it is about: a policy expression
-- runs with the CALLER's privileges, and `authenticated` holds no SELECT on
-- `public.kb_articles`. Adding a client grant to `kb_article_versions` alone
-- would make this policy raise `permission denied for table kb_articles` rather
-- than deny cleanly; it would need `GRANT SELECT ON public.kb_articles` too, or
-- a SECURITY DEFINER helper in `private` to do the lookup.

DROP POLICY IF EXISTS "Signed-in people can read versions of readable articles"
  ON public.kb_article_versions;

CREATE POLICY "Signed-in people can read the live version of readable articles"
  ON public.kb_article_versions
  FOR SELECT TO authenticated USING (
    is_current
    AND EXISTS (
      SELECT 1 FROM public.kb_articles a
      WHERE a.id = kb_article_versions.article_id
        AND a.visibility = 'members'
    )
  );

-- Left untouched, and now the only route to history: "Managers can read all
-- article versions" (20260731140000, renamed by 20260802100000).

NOTIFY pgrst, 'reload schema';
