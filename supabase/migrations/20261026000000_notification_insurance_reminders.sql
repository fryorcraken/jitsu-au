-- Let a notification be an insurance reminder.
--
-- WHY. A yearly insurance membership runs `duration_days` from its start and
-- nothing tells anybody when it ends. The daily job now writes two reminders
-- per membership, 14 days before the end and on the day it ends, as rows in
-- `notifications` so the in-app list, the "sent" state on the manager screens,
-- and the stalled-email check all read one record. See docs/memberships.md,
-- "When yearly insurance ends", and docs/notifications.md.
--
-- WHAT CHANGES. Two CHECK constraints are widened, and nothing else:
--   - `kind` also accepts 'insurance_ending_soon' and 'insurance_ended';
--   - `subject_type` also accepts 'membership', whose `subject_id` is the
--     insurance membership's id.
-- The unique index on (user_id, kind, subject_id) then guarantees each person
-- gets each reminder once per membership, however many times the job runs. No
-- new column, no new table, no grant change, no policy change.
--
-- EVERY VALUE IS LISTED, NOT JUST THE NEW ONES. A CHECK is replaced whole, so
-- this has to carry everything the constraint accepts today, including
-- `membership_plan_open` / `membership_plan_announcement` from
-- 20261025120000_membership_plan_announcement_kind.sql. Read live on
-- 2026-10-26 (pg_constraint, SELECT only): both constraints hold exactly the
-- six kinds and four subject types below minus the three this adds, and that
-- migration is in the ledger. It is dated after it for the same reason: a
-- replay in file order must end with every value present.
--
-- SEQUENCING. Purely additive: every existing row still satisfies the wider
-- check, and the code running today never writes the new values. So this goes
-- live BEFORE the code that writes them (docs/database-changes.md). Until it is
-- applied, the reminder writes are refused by the old CHECK, logged, and the
-- rest of the daily run carries on.
--
-- TYPES.TS. `kind` and `subject_type` are plain `text` there, so nothing needs
-- regenerating for this.
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
    'insurance_ended'
  )
);

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_subject_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_subject_type_check CHECK (
  subject_type IN (
    'blog_comment',
    'kb_annotation',
    'blog_post',
    'membership_plan_announcement',
    'membership'
  )
);
