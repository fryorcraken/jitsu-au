-- The syllabus as structured data: belts, topics, and what each belt asks of
-- each topic.
--
-- Until now each belt's syllabus was one free-form knowledge base article, with
-- the topics (Breakfalling, Striking, Techniques > Throws, ...) existing only as
-- headings inside it. That made the obvious question, "show me breakfalling for
-- every belt up to green", a matter of reading seven pages, and it let a typo in
-- one heading quietly split a topic in two. Here the topics become rows the
-- club manages, and the syllabus becomes one block of text per (belt, topic).
--
-- The belt pages members already read (/kb/yellow-belt and so on) stay ordinary
-- knowledge base articles. Their text is now ASSEMBLED from these blocks and
-- published as a new version whenever a block changes (`src/lib/syllabus.ts`),
-- so comments, reading progress, search, previews and offline reading keep
-- working with nothing special-cased. See docs/syllabus.md.
--
-- Additive only. Nothing is dropped, no column is renamed, and no article text
-- is rewritten: the import below READS each belt page's live version and splits
-- it into blocks, and the pages keep that version until somebody next edits the
-- syllabus. The only change a member can see once this is applied is that the
-- seven belt pages move into a new "Syllabus" section of the sidebar, and moving
-- an article writes no version, so nobody is told a page was updated.

-- ---------- 1. Belts ----------
-- The club's belts, in order. The syllabus is the first thing that uses them;
-- recording which belt each member holds is meant to build on the same rows
-- later, which is why this is its own table rather than a column on an article.
CREATE TABLE IF NOT EXISTS public.belts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 1 AND 50),
  -- "Dark Blue". The belt page's title is built from this and `grade`.
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 50),
  -- "2nd Kyu". Null for a belt with no grade of its own (white, for a novice).
  grade TEXT CHECK (grade IS NULL OR char_length(btrim(grade)) BETWEEN 1 AND 50),
  -- Shown as a swatch beside the belt's name, never as a text colour, so no
  -- value here can make anything unreadable.
  colour TEXT NOT NULL CHECK (colour ~ '^#[0-9a-f]{6}$'),
  -- Junior first. "Everything up to green" means every belt whose position is
  -- at or below green's. Seeded in tens so a belt can be slotted in between two
  -- others without renumbering the rest, like knowledge base sections.
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 2. Topics ----------
-- What the syllabus is organised by. Two levels: a topic (Techniques) and the
-- sub-topics under it (Throws, Locks, ...). Deeper nesting reads badly on a
-- phone, and the "only one level" rule is enforced in `saveSyllabusTopic`
-- rather than here, because a CHECK cannot see the parent row (the same reason
-- one-level-deep replies are enforced in `createAnnotation`).
CREATE TABLE IF NOT EXISTS public.syllabus_topics (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Also the heading's anchor on every belt page (/kb/yellow-belt#breakfalling)
  -- and the `topic=` in a shared link, so it is fixed once made: renaming a
  -- topic changes its title, never this.
  slug TEXT NOT NULL UNIQUE
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 1 AND 100),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  -- RESTRICT: removing a topic that still has sub-topics is refused rather than
  -- taking them with it.
  parent_id UUID REFERENCES public.syllabus_topics(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT syllabus_topics_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS syllabus_topics_parent_idx
  ON public.syllabus_topics (parent_id, position);

-- ---------- 3. Entries: one belt, one topic, one block of text ----------
-- A missing row means "this belt has nothing on this topic", and the belt is
-- skipped under that topic. Clearing a block deletes its row, so there is no
-- empty-string state to tell apart from a missing one.
CREATE TABLE IF NOT EXISTS public.syllabus_entries (
  -- RESTRICT on both: a belt or a topic that still has syllabus text cannot be
  -- deleted out from under it. The app says so in words before it gets here.
  belt_id UUID NOT NULL REFERENCES public.belts(id) ON DELETE RESTRICT,
  topic_id UUID NOT NULL REFERENCES public.syllabus_topics(id) ON DELETE RESTRICT,
  -- Markdown: lists, bold, links and the link previews they bring. Headings are
  -- refused by the app (the topic IS the heading), not here.
  body_md TEXT NOT NULL CHECK (char_length(btrim(body_md)) BETWEEN 1 AND 20000),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (belt_id, topic_id)
);

CREATE INDEX IF NOT EXISTS syllabus_entries_topic_idx ON public.syllabus_entries (topic_id);

-- ---------- 4. Grants and RLS ----------
-- Every new table arrives with all eight privileges granted to both client
-- roles, and GRANT cannot narrow that (docs/database-changes.md). Every read
-- and write goes through a server function on the service role, which enforces
-- who may see which belt in code, exactly as the knowledge base does. So the
-- client roles hold nothing and client-grants-expected.txt gains no line.
REVOKE ALL ON public.belts FROM anon, authenticated;
REVOKE ALL ON public.syllabus_topics FROM anon, authenticated;
REVOKE ALL ON public.syllabus_entries FROM anon, authenticated;
GRANT ALL ON public.belts TO service_role;
GRANT ALL ON public.syllabus_topics TO service_role;
GRANT ALL ON public.syllabus_entries TO service_role;

ALTER TABLE public.belts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.syllabus_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.syllabus_entries ENABLE ROW LEVEL SECURITY;

-- Defence in depth, and unreachable while the client roles hold no grant.
-- Manager-only on purpose, even for belts and topics, which are only names: a
-- grant added later to let a member read them should come with a policy
-- written for that reader, not inherit a permissive one written for nobody.
DROP POLICY IF EXISTS "Managers manage belts" ON public.belts;
CREATE POLICY "Managers manage belts"
  ON public.belts
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

DROP POLICY IF EXISTS "Managers manage syllabus topics" ON public.syllabus_topics;
CREATE POLICY "Managers manage syllabus topics"
  ON public.syllabus_topics
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

DROP POLICY IF EXISTS "Managers manage syllabus entries" ON public.syllabus_entries;
CREATE POLICY "Managers manage syllabus entries"
  ON public.syllabus_entries
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- ---------- 5. The knowledge base side ----------
-- A section's KIND. `syllabus` is the one section that holds the belt pages, and
-- only belt pages: it sorts them by belt, shows the "by topic" view at its top,
-- and refuses an ordinary article. At most one, so "the syllabus section" is
-- never ambiguous.
ALTER TABLE public.kb_sections
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'standard'
    CHECK (kind IN ('standard', 'syllabus'));

CREATE UNIQUE INDEX IF NOT EXISTS kb_sections_one_syllabus
  ON public.kb_sections (kind)
  WHERE kind = 'syllabus';

-- Which belt an article is the syllabus page for. Unique: one page per belt.
-- RESTRICT: a belt with a page cannot be deleted, because knowledge base
-- articles cannot be deleted either and the page would be left describing a
-- belt that no longer exists.
ALTER TABLE public.kb_articles
  ADD COLUMN IF NOT EXISTS belt_id UUID UNIQUE REFERENCES public.belts(id) ON DELETE RESTRICT;

-- A belt page has text of its own (assembled from the syllabus), so it can never
-- be a link entry pointing somewhere else.
ALTER TABLE public.kb_articles DROP CONSTRAINT IF EXISTS kb_articles_belt_page_is_not_a_link;
ALTER TABLE public.kb_articles
  ADD CONSTRAINT kb_articles_belt_page_is_not_a_link
    CHECK (belt_id IS NULL OR link_path IS NULL);

-- ---------- 6. The starting data ----------
-- The club's kyu belts, plus white for somebody not graded yet. White has no
-- syllabus page and is not shown in the syllabus; it is here so that recording
-- members' belts later has a "not graded yet" step to start from. Dan grades are
-- deliberately not belts here: they have a page of their own and no syllabus.
INSERT INTO public.belts (slug, name, grade, colour, position) VALUES
  ('white',      'White',      NULL,      '#f8fafc', 10),
  ('yellow',     'Yellow',     '7th Kyu', '#facc15', 20),
  ('orange',     'Orange',     '6th Kyu', '#f97316', 30),
  ('green',      'Green',      '5th Kyu', '#16a34a', 40),
  ('purple',     'Purple',     '4th Kyu', '#7e22ce', 50),
  ('light-blue', 'Light Blue', '3rd Kyu', '#38bdf8', 60),
  ('dark-blue',  'Dark Blue',  '2nd Kyu', '#1e3a8a', 70),
  ('brown',      'Brown',      '1st Kyu', '#78350f', 80)
ON CONFLICT (slug) DO NOTHING;

-- The topics, in the order most belt pages already use them. Slugs are the
-- anchors those pages have today, so every existing link into a belt page
-- (/kb/green-belt#groundwork-ne-waza) keeps working.
INSERT INTO public.syllabus_topics (slug, title, position) VALUES
  ('breakfalling',    'Breakfalling',    10),
  ('striking',        'Striking',        20),
  ('techniques',      'Techniques',      30),
  ('uke',             'Uke',             40),
  ('scenarios',       'Scenarios',       50),
  ('combat-phases',   'Combat Phases',   60),
  ('self-protection', 'Self-Protection', 70),
  ('concepts',        'Concepts',        80),
  ('drills',          'Drills',          90)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.syllabus_topics (slug, title, position, parent_id)
SELECT v.slug, v.title, v.position, p.id
FROM (VALUES
  ('throws',                    'Throws',                    10),
  ('nage-no-kata-forms',        'Nage no Kata (Forms)',      20),
  ('locks',                     'Locks',                     30),
  ('application-demonstration', 'Application Demonstration', 40),
  ('groundwork-ne-waza',        'Groundwork (Ne Waza)',      50),
  ('coaching',                  'Coaching',                  60)
) AS v(slug, title, position)
JOIN public.syllabus_topics p ON p.slug = 'techniques'
ON CONFLICT (slug) DO NOTHING;

-- The Syllabus section, straight after "Belts and grading" where that exists.
-- A section already called `syllabus` is taken over rather than duplicated.
INSERT INTO public.kb_sections (slug, title, position, kind)
VALUES (
  'syllabus',
  'Syllabus',
  COALESCE((SELECT position + 5 FROM public.kb_sections WHERE slug = 'belts-and-grading'), 65),
  'syllabus'
)
ON CONFLICT (slug) DO UPDATE SET kind = 'syllabus';

-- Attach each existing belt page to its belt and move it into the Syllabus
-- section, ordered by belt. Matched on the slugs the pages have today; a belt
-- with no page is simply left without one. Visibility is untouched, so a page
-- that is managers-only today (brown) stays that way.
UPDATE public.kb_articles a
SET belt_id = b.id,
    section_id = s.id,
    position = b.position,
    updated_at = now()
FROM public.belts b, public.kb_sections s
WHERE a.slug = b.slug || '-belt'
  AND s.kind = 'syllabus'
  AND a.link_path IS NULL
  AND a.belt_id IS NULL;

-- ---------- 7. Import: split each belt page into blocks ----------
-- Read each belt page's LIVE version and file the text under each heading as
-- that belt's block for that topic. `## X` is a topic, `### Y` a sub-topic of
-- the `##` above it, matched by the heading's anchor (which is how the topics
-- above were named).
--
-- It refuses rather than guesses. A heading that is not a topic, a sub-topic
-- under the wrong topic, or text before the first heading raises, naming the
-- page and the heading, and the whole migration rolls back: a page edited since
-- this file was written has to be looked at before it is imported, not imported
-- with a section silently dropped.
--
-- Skipped for a belt that already has blocks, so re-applying is a no-op.
DO $import$
DECLARE
  art RECORD;
  lines TEXT[];
  line TEXT;
  i INTEGER;
  in_fence BOOLEAN;
  buf TEXT[];
  cur_topic UUID;
  cur_parent UUID;
  cur_label TEXT;
  m TEXT[];
  heading TEXT;
  anchor TEXT;
  topic RECORD;
  body TEXT;
BEGIN
  FOR art IN
    SELECT a.slug, a.belt_id, v.body_md
    FROM public.kb_articles a
    JOIN public.kb_article_versions v ON v.article_id = a.id AND v.is_current
    WHERE a.belt_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.syllabus_entries e WHERE e.belt_id = a.belt_id)
  LOOP
    lines := regexp_split_to_array(replace(art.body_md, E'\r', ''), E'\n');
    buf := ARRAY[]::TEXT[];
    cur_topic := NULL;
    cur_parent := NULL;
    cur_label := NULL;
    in_fence := false;

    -- One pass more than there are lines: the last pass is the end of the page,
    -- which flushes the final block exactly as a heading would.
    FOR i IN 1 .. coalesce(array_length(lines, 1), 0) + 1 LOOP
      line := CASE WHEN i <= coalesce(array_length(lines, 1), 0) THEN lines[i] END;

      IF line IS NOT NULL AND line ~ '^\s{0,3}(`{3,}|~{3,})' THEN
        in_fence := NOT in_fence;
      END IF;

      m := CASE
        WHEN line IS NOT NULL AND NOT in_fence THEN regexp_match(line, '^ {0,3}(#{1,6})\s+(.*?)\s*$')
      END;

      IF line IS NULL OR m IS NOT NULL THEN
        -- Flush what has been collected under the previous heading. Blank lines
        -- at either end are dropped; everything in between is kept verbatim.
        body := array_to_string(buf, E'\n');
        body := regexp_replace(body, E'^([ \\t]*\\n)+', '');
        body := regexp_replace(body, E'(\\n[ \\t]*)+$', '');
        IF btrim(body, E' \t\n') <> '' THEN
          IF cur_topic IS NULL THEN
            RAISE EXCEPTION 'Syllabus import: /kb/% has text before its first heading. Move it under a topic and apply again.', art.slug;
          END IF;
          INSERT INTO public.syllabus_entries (belt_id, topic_id, body_md)
          VALUES (art.belt_id, cur_topic, body);
        END IF;
        buf := ARRAY[]::TEXT[];
      END IF;

      IF line IS NULL THEN
        EXIT;
      END IF;

      IF m IS NULL THEN
        buf := buf || line;
        CONTINUE;
      END IF;

      -- The heading's anchor, worked out the way `extractHeadings` does it: a
      -- pinned `{#anchor}` wins, otherwise the words, lowercased, with links
      -- and emphasis taken off and anything else turned into hyphens.
      heading := regexp_replace(m[2], '\s+#+\s*$', '');
      anchor := substring(heading FROM '\{#([^{}[:space:]]+)\}\s*$');
      IF anchor IS NULL THEN
        anchor := heading;
        anchor := regexp_replace(anchor, '!?\[([^]]*)\]\([^)]*\)', '\1', 'g');
        anchor := regexp_replace(anchor, '[`*_]', '', 'g');
      END IF;
      anchor := btrim(regexp_replace(lower(anchor), '[^a-z0-9]+', '-', 'g'), '-');

      SELECT t.id, t.parent_id INTO topic FROM public.syllabus_topics t WHERE t.slug = anchor;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Syllabus import: /kb/% has a heading "%" that is not a syllabus topic. Add the topic to this migration or rename the heading, then apply again.', art.slug, heading;
      END IF;

      IF length(m[1]) = 2 THEN
        IF topic.parent_id IS NOT NULL THEN
          RAISE EXCEPTION 'Syllabus import: /kb/% has "%" as a main heading, but it is a sub-topic.', art.slug, heading;
        END IF;
        cur_parent := topic.id;
      ELSIF length(m[1]) = 3 THEN
        IF topic.parent_id IS DISTINCT FROM cur_parent OR cur_parent IS NULL THEN
          RAISE EXCEPTION 'Syllabus import: /kb/% has "%" under the wrong heading (after "%").', art.slug, heading, cur_label;
        END IF;
      ELSE
        RAISE EXCEPTION 'Syllabus import: /kb/% has a heading "%" at a level the syllabus does not use (only ## and ###).', art.slug, heading;
      END IF;
      cur_topic := topic.id;
      cur_label := heading;
    END LOOP;
  END LOOP;
END
$import$;

COMMENT ON TABLE public.belts IS
  'The club''s belts, junior first by position. A belt''s syllabus page is the kb_articles row whose belt_id names it.';
COMMENT ON TABLE public.syllabus_topics IS
  'What the syllabus is organised by: topics and one level of sub-topics. slug is also the heading anchor on every belt page.';
COMMENT ON TABLE public.syllabus_entries IS
  'One block of markdown per (belt, topic). No row means the belt has nothing on that topic. Belt pages are assembled from these.';

NOTIFY pgrst, 'reload schema';
