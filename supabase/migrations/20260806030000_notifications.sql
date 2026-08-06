-- Notifications: the /notifications page, the sidebar badge, and the email
-- people can turn off.
--
-- Three tables:
--   1. `notifications`             — one row per person per event. This single
--                                    table drives BOTH the in-app list and the
--                                    email, which is why there is no separate
--                                    outbox: `read_at` is the in-app state and
--                                    `emailed_at` is the delivery state.
--   2. `notification_preferences`  — which kinds a person wants EMAILED. It
--                                    never suppresses the in-app row.
--   3. `notification_tokens`       — the credential behind the settings link in
--                                    an email footer, which has to work signed
--                                    out.
--
-- SEQUENCING. Entirely additive (three new tables, no column dropped, no policy
-- narrowed, nothing renamed), so this is an expand-phase migration with no
-- contract half: it goes live BEFORE the code that reads it, and the app runs
-- unchanged until then. See docs/database-changes.md.
--
-- GRANTS. Supabase's bootstrap grants ALL on every new table to `anon` and
-- `authenticated`, and GRANT cannot narrow that — only REVOKE can. So each
-- table below revokes first and grants only `service_role`. Every read and
-- write goes through a server function on the service role, exactly like the
-- `kb_*` tables, so no client grant is kept and
-- supabase/lint/client-grants-expected.txt needs no new line. The RLS policies
-- are defence in depth and are unreachable from a browser today.
--
-- TYPES.TS. `src/integrations/supabase/types.ts` is generated from the live
-- schema, so these tables appear there only once this migration is applied and
-- Lovable regenerates. The column names are pinned in
-- src/integrations/supabase/schema-contract.test.ts (`_NotificationColumns`,
-- `_NotificationPreferenceColumns`, `_NotificationTokenColumns`) so a rename
-- fails `bun run typecheck` rather than failing silently at runtime.

-- ---------- 1. The notifications themselves ----------
CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- To `profiles`, not `auth.users`, matching `kb_annotations.user_id` and
  -- `kb_article_reads.user_id`: a person in this app is a profile, and a
  -- notification for somebody with no club record is not a thing that happens.
  user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('reply', 'thread_activity', 'new_blog_post', 'blog_comment', 'kb_comment')
  ),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('blog_comment', 'kb_annotation', 'blog_post')
  ),
  -- What happened. Deliberately NOT a foreign key: it points at three different
  -- tables depending on `subject_type`, and more importantly the notification
  -- must outlive its subject. A manager deleting an abusive comment should not
  -- silently erase the record that people were told about it.
  subject_id UUID NOT NULL,
  -- Who did it. NULL once that account is gone; the notification still reads
  -- fine because the name is frozen into `title`/`body` below.
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Frozen at write time, the same call `waivers` makes about its person
  -- fields: a notification is a record of a moment, not a live view of one.
  -- Rendering from a join would also mean every list read has to re-check
  -- article visibility, and one missed check leaks a members-only passage into
  -- somebody's inbox.
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body TEXT CHECK (body IS NULL OR char_length(body) <= 500),
  -- Where "open" goes. A site-relative path, never an absolute URL: the email
  -- sender prefixes the origin, and storing one would bake the host into rows
  -- that outlive it.
  href TEXT NOT NULL CHECK (href LIKE '/%'),
  -- NULL = unread. Drives the sidebar badge.
  read_at TIMESTAMPTZ,
  -- NULL = not yet considered for email. The digest stamps this on EVERY row it
  -- considers, including ones a preference suppressed, so switching a kind back
  -- on is forward-looking instead of releasing a backlog.
  emailed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The idempotency guard, and the reason `blog_posts` needs no `announced_at`
-- column: a post that is unpublished and republished cannot produce a second
-- announcement, because the second insert collides here. `published_at` could
-- not have carried that, since it is deliberately never cleared
-- (`resolvePublishedAt` in src/lib/blog.functions.ts). Every writer uses
-- ON CONFLICT DO NOTHING against this constraint.
CREATE UNIQUE INDEX notifications_user_kind_subject_key
  ON public.notifications (user_id, kind, subject_id);

-- "This person's list, newest first" — the only query the page makes.
CREATE INDEX notifications_user_created_idx
  ON public.notifications (user_id, created_at DESC);

-- The badge asks "how many unread" on every member-space page load, so it gets
-- its own partial index rather than scanning a person's whole history.
CREATE INDEX notifications_unread_idx
  ON public.notifications (user_id) WHERE read_at IS NULL;

-- The digest sweeps this across everybody, so it must not be a full scan.
CREATE INDEX notifications_unemailed_idx
  ON public.notifications (created_at) WHERE emailed_at IS NULL;

REVOKE ALL ON public.notifications FROM anon, authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Defence in depth, and unreachable today: there is no client grant, and every
-- read and write goes through a server function on the service role. Written
-- anyway, and owner-scoped in both directions with no manager policy — the same
-- call `kb_article_reads` makes. A manager reading other people's notifications
-- would be reading who replied to whom, which is nobody's business but theirs.
CREATE POLICY "People can read their own notifications"
  ON public.notifications
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "People can mark their own notifications read"
  ON public.notifications
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ---------- 2. Email preferences ----------
CREATE TABLE public.notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  -- All four are NULLABLE ON PURPOSE. NULL means "never chose", which a
  -- NOT NULL DEFAULT cannot express: with a default, changing the club's mind
  -- about a default later either moves nobody (if the column was backfilled) or
  -- moves everybody including people who deliberately switched it off. NULL
  -- plus NOTIFICATION_DEFAULTS in src/lib/notifications.ts keeps "unset" and
  -- "off" distinguishable, and puts the fallback somewhere unit-testable.
  reply_to_me BOOLEAN,
  thread_activity BOOLEAN,
  new_blog_post BOOLEAN,
  -- Only consulted for someone holding the `manager` role. Kept on the same row
  -- rather than in a manager-only table because roles come and go and the
  -- preference should survive losing and regaining one.
  manager_comment_alerts BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON public.notification_preferences FROM anon, authenticated;
GRANT ALL ON public.notification_preferences TO service_role;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "People can read their own notification preferences"
  ON public.notification_preferences
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- ---------- 3. The settings link in an email footer ----------
CREATE TABLE public.notification_tokens (
  user_id UUID PRIMARY KEY REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  -- The RAW token is stored, not just its hash, for the same reason
  -- `calendar_feed_tokens` stores one: the server has to be able to PUT this
  -- link into an email it composes later, which a one-way hash cannot do. The
  -- hash is kept alongside so lookups are constant-time-comparable and so a
  -- future rotate-and-show-once flow needs no schema change.
  token TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON public.notification_tokens FROM anon, authenticated;
GRANT ALL ON public.notification_tokens TO service_role;
ALTER TABLE public.notification_tokens ENABLE ROW LEVEL SECURITY;

-- No policy at all, deliberately. This table holds a credential that grants
-- signed-out access to somebody's email settings; `authenticated` has no grant
-- and no reason to read even its own row, since the page it powers is reached
-- from a link rather than by looking the token up. RLS is enabled so the table
-- is closed rather than merely ungranted.

NOTIFY pgrst, 'reload schema';
