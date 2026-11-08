-- Club messages: a manager writes one email and sends it to the people they
-- tick (members, visitors and lapsed members, applicants, chosen leads).
-- Product rules: docs/club-messages.md.
--
-- WHAT CHANGES, all of it additive:
--
-- 1. `interest_registrations` gains `promotion_consent`: the unticked "Keep
--    me posted about club events and offers" box on the interest form.
--    Nothing sends promotions yet; the box ships first so consent builds up
--    before the feature does. The anon insert policy is untouched: the column
--    is a plain boolean the visitor chooses, defaulting to false, and the
--    existing INSERT grant already covers it.
--
-- 2. `club_messages`: one row per message sent, the record the manager's
--    history reads. Its `id` is minted by the screen (or the agent) and is the
--    whole retry story: the same id again sends only what is still unsent.
--    `recipients_written_at` is set once every recipient row exists, which
--    freezes the audience: "Send the rest" an hour later finishes the same
--    list rather than adding whoever joined in between.
--
-- 3. `club_message_lead_recipients`: one row per lead per message, so a lead
--    is emailed once and "send the rest" knows who is left. Leads have no
--    person record, so they cannot have a `notifications` row. It holds NO
--    address: the address is read from the registration at send time, and
--    the foreign key CASCADES, so a manager deleting a lead (the product's
--    only erasure path, docs/erasing-personal-data.md) takes these rows with
--    it.
--
-- 4. `notifications` accepts kind 'club_notice' and subject type
--    'club_message', for the members' copy (one row per inbox, which is what
--    puts it on /notifications and lets the morning summary send anything the
--    immediate send did not). Every existing value is listed again, because a
--    CHECK is replaced whole; the list matches
--    20261026000000_notification_insurance_reminders.sql, the last migration
--    to touch either constraint.
--
-- GRANTS. Both new tables are service role only: every read and write goes
-- through a manager-gated server function. Nothing changes for `anon` or
-- `authenticated`, so supabase/lint/client-grants-expected.txt is unchanged.
--
-- SEQUENCING. Additive, so it goes live BEFORE the code that uses it
-- (docs/database-changes.md). The code running today never reads or writes
-- any of it.

-- ---- 1. leads ----

ALTER TABLE public.interest_registrations
  ADD COLUMN promotion_consent BOOLEAN NOT NULL DEFAULT false;

-- ---- 2. the messages ----

CREATE TABLE public.club_messages (
  id UUID PRIMARY KEY,
  -- 'promotion' joins this list when promotions ship.
  kind TEXT NOT NULL CHECK (kind IN ('notice')),
  subject TEXT NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 20000),
  -- The groups the manager ticked, for the history. Never an address.
  audience JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  recipients_written_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX club_messages_created_at_idx ON public.club_messages (created_at DESC);

ALTER TABLE public.club_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.club_messages TO service_role;

-- ---- 3. which leads each message went to ----

CREATE TABLE public.club_message_lead_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.club_messages(id) ON DELETE CASCADE,
  interest_registration_id UUID NOT NULL
    REFERENCES public.interest_registrations(id) ON DELETE CASCADE,
  emailed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, interest_registration_id)
);

CREATE INDEX club_message_lead_recipients_registration_idx
  ON public.club_message_lead_recipients (interest_registration_id);

ALTER TABLE public.club_message_lead_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_message_lead_recipients FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.club_message_lead_recipients TO service_role;

-- ---- 4. the members' copy ----

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check CHECK (
  kind IN (
    'reply',
    'thread_activity',
    'new_blog_post',
    'blog_comment',
    'kb_comment',
    'membership_plan_open',
    'insurance_ending_soon',
    'insurance_ended',
    'club_notice'
  )
);

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_subject_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_subject_type_check CHECK (
  subject_type IN (
    'blog_comment',
    'kb_annotation',
    'blog_post',
    'membership_plan_announcement',
    'membership',
    'club_message'
  )
);
