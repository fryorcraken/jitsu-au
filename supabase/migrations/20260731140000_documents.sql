-- Club documents: versioned markdown pages people can read and annotate.
--
-- The club already keeps documents in two places that disagree with each other:
-- markdown in git, and a hand-maintained Google Doc mirror that exists only so
-- people can leave comments. This replaces the mirror. The document lives here,
-- managers edit it (through the manager agent API), and readers annotate it on
-- the site under their own club login instead of a second Google account.
--
-- Three tables, and the split matters:
--
--   * `documents` is the IDENTITY of a document — its slug, who may read it.
--     A slug is a permanent URL (`/docs/house-rules`), so nothing here is
--     rewritten when the text changes.
--   * `document_versions` is the TEXT, one row per saved version. Same shape as
--     `waiver_templates`: saving writes a new row and promotes it, so the
--     history is intact and an annotation can name the wording it was written
--     against.
--   * `document_annotations` is what readers wrote, private or shared.
--
-- Deliberately NOT modelled on `waivers`: nothing here is legal evidence, there
-- is no PDF, no approval, and no signature. A document is a page to read, and an
-- annotation is a comment on it. Both are editable and deletable by their author.

-- ---------- documents ----------
CREATE TABLE public.documents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- The URL key, and the identifier every API call uses. Constrained to a
  -- lowercase kebab-case word so a slug can never need escaping in a path, and
  -- so `save_document` can treat "slug I have not seen" as "create this one"
  -- without a typo silently minting a second document with a near-identical URL.
  slug TEXT NOT NULL UNIQUE
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 1 AND 100),
  -- Who may read it. `members` is the default on purpose: these are club
  -- documents (handbooks, policies, proposals), and the safe failure for a
  -- mis-set visibility is "a member had to sign in", not "a draft policy was
  -- public". Making one public is a deliberate edit.
  --   public   — anyone, signed in or not
  --   members  — any signed-in person the club knows
  --   managers — managers only (drafts, internal notes)
  visibility TEXT NOT NULL DEFAULT 'members'
    CHECK (visibility IN ('public', 'members', 'managers')),
  -- Lets a document be published read-only. Annotation is the point of this
  -- feature, so it defaults on, but a finalised policy should be able to stop
  -- taking comments without being deleted or unpublished.
  annotations_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The manager who created it. Nullable and ON DELETE SET NULL: a document
  -- outlives the person who filed it, and losing an author must never cascade
  -- into deleting the club's policies.
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- ---------- document_versions ----------
CREATE TABLE public.document_versions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  -- Per-document, starting at 1. NOT global: "version 3 of the house rules"
  -- is what a manager says, and a shared counter would make that meaningless.
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  -- 200k of markdown. Larger than the waiver's 30k because these are handbooks
  -- and policies, not a one-page form, but still bounded: the whole body is
  -- read into memory and rendered on every page view.
  body_md TEXT NOT NULL CHECK (char_length(body_md) BETWEEN 1 AND 200000),
  -- What changed, in the manager's own words. Shown to readers whose annotations
  -- were written against an older version, which is the one moment where "what
  -- did you change?" is a real question rather than trivia.
  change_note TEXT CHECK (char_length(change_note) <= 500),
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (document_id, version)
);

-- Exactly one live version PER DOCUMENT. The waiver's equivalent index
-- (`waiver_templates_only_one_current`) is global because there is one waiver;
-- here the partial index is keyed on document_id, so promoting a version of one
-- document cannot collide with another document's live version.
--
-- As with the waiver, this makes promotion necessarily demote-then-promote —
-- see `promoteDocumentVersion`, which orders those writes so a failure leaves
-- the previous version live rather than leaving the document with none.
CREATE UNIQUE INDEX document_versions_one_current_per_document
  ON public.document_versions (document_id) WHERE is_current;

-- The reader's query: this document's versions, newest first.
CREATE INDEX document_versions_document_idx
  ON public.document_versions (document_id, version DESC);

-- ---------- document_annotations ----------
CREATE TABLE public.document_annotations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  -- The version number this was written against. Kept as a plain integer rather
  -- than a foreign key to `document_versions`, matching `waivers.template_version`:
  -- the annotation should survive a version row being tidied up, and what it
  -- needs to record is "which wording was on screen", not a live join.
  document_version INTEGER NOT NULL CHECK (document_version > 0),
  -- Annotating requires being a person the club knows. There is no anonymous
  -- commenting: a comment thread nobody can be identified in is not a
  -- conversation, and private notes are meaningless without an owner.
  user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  -- ---- Anchoring ----
  -- Which block of the document this hangs off. Computed from the block's own
  -- text (see `blockId` in src/lib/documents.ts), NOT its position, so inserting
  -- a paragraph above does not move every annotation below it. NULL means a
  -- document-level note rather than a comment on a particular passage.
  block_id TEXT CHECK (char_length(block_id) <= 100),
  -- The block's text as it stood when the annotation was written. This is the
  -- fallback anchor and the honesty mechanism in one: if an edit changes a
  -- paragraph, `block_id` stops matching, and the quote is what lets the reader
  -- be shown "this comment was about wording that has since changed" instead of
  -- the comment being silently re-pointed at a paragraph nobody commented on.
  quote TEXT CHECK (char_length(quote) <= 2000),
  -- `private` is a note only its author can ever read. `shared` is a comment
  -- thread visible to everyone who can read the document. This column is the
  -- whole privacy model, which is why the RLS policies below key off it.
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'shared')),
  -- A reply. One level only (a reply may not itself be replied to) — enforced in
  -- `createAnnotation`, since a CHECK cannot look at the parent row. Threads
  -- stay readable and there is no tree to render.
  --
  -- CASCADE is deliberate: deleting a thread's root is a moderation action, and
  -- taking an abusive comment off a page should take the conversation hanging
  -- off it too. Note the second-order effect, which the UI cannot warn about:
  -- combined with `user_id`'s CASCADE above, deleting ONE person's profile
  -- deletes their roots, and with them OTHER people's replies. Deleting a
  -- profile is already a destructive admin action; this is one more thing it
  -- destroys. Recorded in docs/database.md.
  parent_id UUID REFERENCES public.document_annotations(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  -- Resolving a thread. Set by the thread's author or a manager; a resolved
  -- thread collapses rather than disappearing, so "we dealt with this" is
  -- recorded rather than deleted.
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A private note is by definition not a conversation, so it can never be a
  -- reply and can never be replied to. The half of that a CHECK can see (this
  -- row is private AND has a parent) is enforced here; the other half is in
  -- `createAnnotation`.
  CONSTRAINT document_annotations_private_has_no_parent
    CHECK (parent_id IS NULL OR visibility = 'shared')
);

-- Rendering a document reads every annotation on it in one go, then groups them
-- by block in the app. Ordering by created_at here is what makes a thread read
-- in the order it was written without a second sort.
CREATE INDEX document_annotations_document_idx
  ON public.document_annotations (document_id, created_at);

-- "My private notes" is the other query shape, and it is per-person.
CREATE INDEX document_annotations_user_idx
  ON public.document_annotations (user_id, created_at DESC);

-- Replies are always fetched by thread.
CREATE INDEX document_annotations_parent_idx
  ON public.document_annotations (parent_id) WHERE parent_id IS NOT NULL;

-- ---------- Grants ----------
-- Supabase's bootstrap grants ALL on every new table in `public` to anon and
-- authenticated, and GRANT cannot narrow that — only REVOKE can, so the REVOKE
-- comes first (docs/database-changes.md).
--
-- None of these tables is reached from a browser or from an anon-key server
-- client. Every read and write runs through a server function on the service
-- role (src/lib/documents.functions.ts) or the manager agent endpoint, both of
-- which enforce visibility in code, so the client roles get nothing and
-- `supabase/lint/client-grants-expected.txt` needs no entry.
REVOKE ALL ON public.documents FROM anon, authenticated;
REVOKE ALL ON public.document_versions FROM anon, authenticated;
REVOKE ALL ON public.document_annotations FROM anon, authenticated;
GRANT ALL ON public.documents TO service_role;
GRANT ALL ON public.document_versions TO service_role;
GRANT ALL ON public.document_annotations TO service_role;

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_annotations ENABLE ROW LEVEL SECURITY;

-- Defence in depth, as on `session_checkins` and `code_of_conduct_acceptances`:
-- with no client grant these policies are unreachable today. They encode the
-- READ rules the server functions enforce, so the two cannot drift into
-- disagreement about who may see what.
--
-- Two things they are NOT, stated here so nobody mistakes them for a complete
-- second lock:
--
--   * There are no INSERT/UPDATE/DELETE policies. Every write runs through a
--     server function on the service role, and with RLS enabled and no policy,
--     a client write is denied by default. That is the intended outcome, but it
--     means these policies describe reads only.
--   * The two policies below that sub-select `public.documents` carry a
--     CO-REQUISITE: a policy expression runs with the CALLER's privileges, and
--     `authenticated` holds no SELECT on `public.documents` (revoked above and
--     never granted back). So anyone who reached them today would get
--     `permission denied for table documents`, not a clean deny. This is the
--     exact trap documented in docs/database-changes.md ("An RLS policy that
--     references another table needs a grant on that table"). If a client grant
--     is ever added to `document_versions` or `document_annotations`, it must
--     come with either `GRANT SELECT ON public.documents` or a SECURITY DEFINER
--     helper to do the lookup — adding the grant alone leaves these broken.
CREATE POLICY "Signed-in people can read member documents"
  ON public.documents
  FOR SELECT TO authenticated USING (visibility IN ('public', 'members'));
CREATE POLICY "Managers can read all documents"
  ON public.documents
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Signed-in people can read versions of readable documents"
  ON public.document_versions
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_versions.document_id
        AND d.visibility IN ('public', 'members')
    )
  );
CREATE POLICY "Managers can read all document versions"
  ON public.document_versions
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));

-- The privacy rule, stated once: a private note is readable only by its author;
-- a shared one by anyone who can read the document.
CREATE POLICY "People can read their own annotations"
  ON public.document_annotations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "People can read shared annotations on readable documents"
  ON public.document_annotations
  FOR SELECT TO authenticated USING (
    visibility = 'shared'
    AND EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_annotations.document_id
        AND d.visibility IN ('public', 'members')
    )
  );
-- Managers moderate: they can read everything shared, but NOT other people's
-- private notes. A private note is private from the club too — that is what
-- makes it usable for "things I want to remember about this policy".
CREATE POLICY "Managers can read shared annotations"
  ON public.document_annotations
  FOR SELECT TO authenticated USING (
    visibility = 'shared' AND public.has_role(auth.uid(), 'manager')
  );

NOTIFY pgrst, 'reload schema';
