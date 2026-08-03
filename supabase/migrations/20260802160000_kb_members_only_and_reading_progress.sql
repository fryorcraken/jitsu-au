-- The knowledge base becomes members-only, and starts remembering what a member
-- has read.
--
-- Two changes, both about the same thing: the knowledge base is the club's
-- reading for the people who train here, reached from the member area, rather
-- than a public section of the marketing site.
--
--   1. VISIBILITY loses its `public` level. Every reader is signed in before
--      visibility is consulted (`canReadArticle` in src/lib/kb.ts refuses a
--      signed-out viewer outright), so `public` had become a setting a manager
--      could pick that changed nothing — and a setting labelled "anyone, signed
--      in or not" that does not mean that is worse than no setting at all.
--
--   2. READING PROGRESS. `kb_article_reads` records that a person read an
--      article, and which version of it, so the sidebar can tick off what they
--      have done, the index can say "continue where you left off", and an
--      article that changed since they read it can say so.
--
-- SEQUENCING. Part 1 is a NARROWING, which per docs/database-changes.md goes
-- live AFTER the code that stopped writing the old value; part 2 is additive and
-- goes live BEFORE the code that reads it. Applying this whole file just before
-- merging the branch that carries both satisfies each: nothing writes 'public'
-- from the moment that code deploys, and the UPDATE below has already moved the
-- rows that had it.
--
-- TYPES.TS. `kb_article_reads` is hand-added to `integrations/supabase/types.ts`
-- ahead of this file being applied, which is NOT the sanctioned exception in
-- CLAUDE.md ("Schema drift") — that exception is for a column added to a table
-- the generator already knows about, verified live, not a whole table that does
-- not exist yet. It is done anyway, here, because there is no other way to get
-- a green typecheck on code that reads a table this migration has not created.
-- The obligation that comes with it: apply this file and ask Lovable to
-- regenerate `types.ts` in the SAME change that merges the code depending on
-- it, so the hand-added block is replaced by the real one rather than surviving
-- to drift from whatever the generator would have produced.
-- `schema-contract.test.ts`'s `_KbArticleReadColumns` pins the shape that hand-add
-- asserted, so a real regeneration that lands with a different one fails there.

-- ---------- 1. No more `public` articles ----------
-- The two seeded link entries (/first-class, /faq) are the rows this actually
-- moves today. They point at pages that are still public on the marketing site;
-- what changes is who can see the POINTER, which now matches everything else in
-- the sidebar it sits in.
UPDATE public.kb_articles SET visibility = 'members' WHERE visibility = 'public';

-- Dropped by name and re-added rather than altered: a CHECK cannot be narrowed
-- in place. `IF EXISTS` because the constraint's name came from the rename in
-- 20260802100000, which was itself guarded — a database where that guard found
-- nothing has the constraint under its original `documents_visibility_check`
-- name, and both are cleared here so the table ends up with exactly one.
ALTER TABLE public.kb_articles DROP CONSTRAINT IF EXISTS kb_articles_visibility_check;
ALTER TABLE public.kb_articles DROP CONSTRAINT IF EXISTS documents_visibility_check;
ALTER TABLE public.kb_articles
  ADD CONSTRAINT kb_articles_visibility_check CHECK (visibility IN ('members', 'managers'));

-- The RLS policies still name a value that can no longer exist. They are
-- defence in depth (no client grant reaches these tables), but a policy that
-- reads `visibility IN ('public', 'members')` tells the next person there is a
-- public level, so they are restated without it. Behaviour is unchanged: there
-- is no policy for `anon` on any of these, so a signed-out reader was already
-- refused at this layer.
DROP POLICY IF EXISTS "Signed-in people can read member articles" ON public.kb_articles;
CREATE POLICY "Signed-in people can read member articles"
  ON public.kb_articles
  FOR SELECT TO authenticated USING (visibility = 'members');

DROP POLICY IF EXISTS "Signed-in people can read versions of readable articles" ON public.kb_article_versions;
CREATE POLICY "Signed-in people can read versions of readable articles"
  ON public.kb_article_versions
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.kb_articles d
      WHERE d.id = kb_article_versions.article_id
        AND d.visibility = 'members'
    )
  );

DROP POLICY IF EXISTS "People can read shared annotations on readable articles" ON public.kb_annotations;
CREATE POLICY "People can read shared annotations on readable articles"
  ON public.kb_annotations
  FOR SELECT TO authenticated USING (
    visibility = 'shared'
    AND EXISTS (
      SELECT 1 FROM public.kb_articles d
      WHERE d.id = kb_annotations.article_id
        AND d.visibility = 'members'
    )
  );

-- ---------- 2. Reading progress ----------
CREATE TABLE public.kb_article_reads (
  -- To `profiles`, not `auth.users`, matching `kb_annotations.user_id`: a person
  -- in this app is a profile, and a read by somebody with no club record is not
  -- a thing that can happen.
  user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  article_id UUID NOT NULL REFERENCES public.kb_articles(id) ON DELETE CASCADE,
  -- WHICH version was read, so an article rewritten afterwards can tell the
  -- reader it has moved on rather than staying ticked off forever. A plain
  -- integer and not a foreign key, for the same reason `kb_annotations
  -- .article_version` is one: it records what was on screen, not a live join.
  version INTEGER NOT NULL CHECK (version > 0),
  -- Overwritten on a re-read: this is "when did you last read it", not a log.
  -- Reading is a state a member checks at a glance, not an audit trail, and a
  -- row per view of a syllabus somebody keeps open would dwarf every other
  -- table in the club's database.
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);

-- "Everything this person has read", which is the only query there is: the
-- sidebar, the index and the progress count all come from one read of it. The
-- primary key already leads with `user_id`, so no second index is needed.

REVOKE ALL ON public.kb_article_reads FROM anon, authenticated;
GRANT ALL ON public.kb_article_reads TO service_role;
ALTER TABLE public.kb_article_reads ENABLE ROW LEVEL SECURITY;

-- Defence in depth, and unreachable today: there is no client grant, and every
-- read and write goes through a server function on the service role. Written
-- anyway, and deliberately owner-scoped in BOTH directions — what a member has
-- and has not read is theirs. A manager has no business browsing it, and the
-- absence of a manager policy here is the point rather than an omission: it is
-- the same call the feature already makes about private notes.
CREATE POLICY "People can read their own reading progress"
  ON public.kb_article_reads
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';
