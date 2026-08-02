-- Club documents become the knowledge base: an ordered, navigable section of the
-- site rather than a flat alphabetical list nothing links to.
--
-- Two things happen here, and they are separable in the reading but not in the
-- applying (one rename, one addition, both atomic):
--
--   1. RENAME. `documents` -> `kb_articles`, and the two tables hanging off it.
--      Purely a naming change: no data moves, no column type changes, nothing is
--      dropped. It is safe to do now precisely because the feature is days old
--      and NOTHING on the site links to /docs, so there is no live traffic to
--      break in the window between applying this and deploying the code.
--
--   2. ORDER. A `kb_sections` table, plus `section_id` / `position` on an
--      article, so a manager can decide what a new member reads first. That
--      single ordering drives the sidebar, the index page and the prev/next
--      links, so there is one thing to maintain rather than three.
--
-- `link_path` is the odd one out and is explained where it is defined.

-- ---------- 1. Rename the tables ----------
-- Postgres rewrites the stored expressions of policies, CHECKs and FK targets
-- through a rename, so nothing below has to restate them. What it does NOT
-- rename is the objects' own names, which is what part 2 of this section is for.
ALTER TABLE public.documents RENAME TO kb_articles;
ALTER TABLE public.document_versions RENAME TO kb_article_versions;
ALTER TABLE public.document_annotations RENAME TO kb_annotations;

ALTER TABLE public.kb_article_versions RENAME COLUMN document_id TO article_id;
ALTER TABLE public.kb_annotations RENAME COLUMN document_id TO article_id;
-- `document_version` -> `article_version`. Still a plain integer and still not a
-- foreign key, for the reason the original migration gives: it records which
-- wording was on screen, not a live join.
ALTER TABLE public.kb_annotations RENAME COLUMN document_version TO article_version;

-- Indexes and constraints keep their old names through a table rename, which
-- would leave a reader of `\d kb_articles` looking at `documents_slug_check` and
-- a CHECK violation quoting a table that no longer exists.
--
-- Guarded rather than bare `ALTER`: the auto-generated names below are
-- predictable (`<table>_<column>_check`, `<table>_pkey`, `<table>_<column>_key`)
-- but they are Postgres's to choose, and a migration that fails on a name
-- mismatch would leave the rename half-applied against the live database. A
-- no-op on an unexpected name is the right failure here, since none of these
-- names carries behaviour.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('kb_articles',         'documents_pkey',                             'kb_articles_pkey'),
      ('kb_articles',         'documents_slug_key',                         'kb_articles_slug_key'),
      ('kb_articles',         'documents_slug_check',                       'kb_articles_slug_check'),
      ('kb_articles',         'documents_visibility_check',                 'kb_articles_visibility_check'),
      ('kb_articles',         'documents_created_by_fkey',                  'kb_articles_created_by_fkey'),
      ('kb_article_versions', 'document_versions_pkey',                     'kb_article_versions_pkey'),
      ('kb_article_versions', 'document_versions_document_id_fkey',         'kb_article_versions_article_id_fkey'),
      ('kb_article_versions', 'document_versions_document_id_version_key',  'kb_article_versions_article_id_version_key'),
      ('kb_article_versions', 'document_versions_version_check',            'kb_article_versions_version_check'),
      ('kb_article_versions', 'document_versions_title_check',              'kb_article_versions_title_check'),
      ('kb_article_versions', 'document_versions_body_md_check',            'kb_article_versions_body_md_check'),
      ('kb_article_versions', 'document_versions_change_note_check',        'kb_article_versions_change_note_check'),
      ('kb_article_versions', 'document_versions_created_by_fkey',          'kb_article_versions_created_by_fkey'),
      ('kb_annotations',      'document_annotations_pkey',                  'kb_annotations_pkey'),
      ('kb_annotations',      'document_annotations_document_id_fkey',      'kb_annotations_article_id_fkey'),
      ('kb_annotations',      'document_annotations_user_id_fkey',          'kb_annotations_user_id_fkey'),
      ('kb_annotations',      'document_annotations_parent_id_fkey',        'kb_annotations_parent_id_fkey'),
      ('kb_annotations',      'document_annotations_resolved_by_fkey',      'kb_annotations_resolved_by_fkey'),
      ('kb_annotations',      'document_annotations_document_version_check','kb_annotations_article_version_check'),
      ('kb_annotations',      'document_annotations_block_id_check',        'kb_annotations_block_id_check'),
      ('kb_annotations',      'document_annotations_quote_check',           'kb_annotations_quote_check'),
      ('kb_annotations',      'document_annotations_visibility_check',      'kb_annotations_visibility_check'),
      ('kb_annotations',      'document_annotations_body_check',            'kb_annotations_body_check'),
      ('kb_annotations',      'document_annotations_private_has_no_parent', 'kb_annotations_private_has_no_parent')
    ) AS t(tbl, old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'public' AND rel.relname = r.tbl AND c.conname = r.old_name
    ) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;

  FOR r IN
    SELECT * FROM (VALUES
      ('document_versions_one_current_per_document', 'kb_article_versions_one_current_per_article'),
      ('document_versions_document_idx',             'kb_article_versions_article_idx'),
      ('document_annotations_document_idx',          'kb_annotations_article_idx'),
      ('document_annotations_user_idx',              'kb_annotations_user_idx'),
      ('document_annotations_parent_idx',            'kb_annotations_parent_idx')
    ) AS t(old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = r.old_name AND c.relkind = 'i'
    ) THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- Policy names are not rewritten either. The bodies are, so these still say what
-- they said; only the wording of the name changes.
ALTER POLICY "Signed-in people can read member documents"
  ON public.kb_articles RENAME TO "Signed-in people can read member articles";
ALTER POLICY "Managers can read all documents"
  ON public.kb_articles RENAME TO "Managers can read all articles";
ALTER POLICY "Signed-in people can read versions of readable documents"
  ON public.kb_article_versions RENAME TO "Signed-in people can read versions of readable articles";
ALTER POLICY "Managers can read all document versions"
  ON public.kb_article_versions RENAME TO "Managers can read all article versions";
ALTER POLICY "People can read shared annotations on readable documents"
  ON public.kb_annotations RENAME TO "People can read shared annotations on readable articles";

-- ---------- 2. Sections ----------
CREATE TABLE public.kb_sections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 1 AND 100),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  -- Lower sorts first. Seeded in tens so a manager can drop a section between
  -- two others without renumbering the rest, which is the whole difference
  -- between "reorder the knowledge base" being one call and being five.
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON public.kb_sections FROM anon, authenticated;
GRANT ALL ON public.kb_sections TO service_role;
ALTER TABLE public.kb_sections ENABLE ROW LEVEL SECURITY;

-- Defence in depth, and unreachable today for the same reason as the tables
-- above: no client grant, every read goes through a server function on the
-- service role. A section is a heading and a number, so there is nothing here to
-- keep from a signed-in reader; what an article says, and whether they may see
-- it at all, is decided on the article.
CREATE POLICY "Signed-in people can read knowledge base sections"
  ON public.kb_sections
  FOR SELECT TO authenticated USING (true);

-- ---------- 3. Ordering and link entries on an article ----------
ALTER TABLE public.kb_articles
  -- ON DELETE SET NULL, never CASCADE: deleting a section is a tidy-up of the
  -- navigation, and it must never take the club's articles with it. They fall
  -- into the "Everything else" group instead, which is visible and recoverable.
  ADD COLUMN section_id UUID REFERENCES public.kb_sections(id) ON DELETE SET NULL,
  ADD COLUMN position INTEGER NOT NULL DEFAULT 0,
  -- The sidebar label, when it should differ from the article's title. A
  -- syllabus page can be called "The full syllabus for every belt" at the top
  -- and just "Syllabus" in the nav.
  --
  -- It is also what gives a LINK ENTRY a name, since a link entry has no version
  -- and therefore no title. Hence the CHECK below.
  ADD COLUMN nav_title TEXT CHECK (char_length(nav_title) BETWEEN 1 AND 100),
  -- A sidebar entry that is a link to a page elsewhere on this site rather than
  -- an article stored here.
  --
  -- The club already answers "your first session" at /first-class and the common
  -- questions at /faq, written for somebody deciding whether to come. Retelling
  -- either inside the knowledge base would mean two versions to keep in step, so
  -- the sidebar points at the real page instead and the reading order flows
  -- straight through it.
  --
  -- Site-relative paths ONLY. An arbitrary URL here would put whatever a caller
  -- liked into the club's own navigation, and turn /kb/<slug> into an open
  -- redirect; the pattern forbids `//host`, a scheme, and a bare word.
  ADD COLUMN link_path TEXT
    CHECK (link_path IS NULL OR (link_path ~ '^/[a-z0-9][a-z0-9/-]*$' AND link_path !~ '//')),
  -- A link entry has no version to borrow a title from, so it must carry its own.
  ADD CONSTRAINT kb_articles_link_entry_is_named
    CHECK (link_path IS NULL OR nav_title IS NOT NULL);

-- The sidebar's query: everything in a section, in order.
CREATE INDEX kb_articles_section_idx ON public.kb_articles (section_id, position);

-- The other half of "a link entry has no body" — that it must never acquire a
-- version — is enforced in `saveKbArticle` rather than here. A CHECK cannot see
-- another table, and the alternative (a trigger pair, one per direction) is more
-- machinery than the rule is worth. This follows the precedent already set for
-- one-level-deep replies, which `createAnnotation` enforces for the same reason.

-- ---------- 4. The starting structure ----------
-- Seeded so the knowledge base is navigable the moment it ships rather than
-- being an empty shell somebody has to shape before it does anything. Every row
-- here is ordinary data a manager can rename, reorder or delete through the
-- agent API; nothing in the code depends on these slugs existing.
INSERT INTO public.kb_sections (slug, title, position) VALUES
  ('start-here',        'Start here',        10),
  ('belts-and-grading', 'Belts and grading', 20),
  ('about-the-club',    'About the club',    30)
ON CONFLICT (slug) DO NOTHING;

-- The two link entries. `public` visibility because both destinations are public
-- marketing pages: hiding the pointer from a signed-out reader while the page it
-- points at is indexed would be theatre.
INSERT INTO public.kb_articles (slug, visibility, annotations_enabled, section_id, position, nav_title, link_path)
SELECT v.slug, 'public', false, s.id, v.position, v.nav_title, v.link_path
FROM (VALUES
  ('your-first-session', 10, 'Your first session', '/first-class'),
  ('common-questions',   40, 'Common questions',   '/faq')
) AS v(slug, position, nav_title, link_path)
JOIN public.kb_sections s ON s.slug = 'start-here'
ON CONFLICT (slug) DO NOTHING;

NOTIFY pgrst, 'reload schema';
