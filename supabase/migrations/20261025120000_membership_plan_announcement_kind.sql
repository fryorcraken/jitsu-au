-- Admit the membership plan announcement as a kind of notification.
--
-- WHAT IT IS FOR. A manager can now tick "Email all members about this plan"
-- when they save a plan on /manager/membership-plans (or pass `announce: true`
-- to the manager agent API's `save_membership_plan`). Each announcement writes
-- one `notifications` row per inbox it reaches and emails it straight away
-- (`docs/notifications.md`, "A plan is announced"). Storing it as rows, rather
-- than sending and forgetting, is what makes a retried save safe (the unique
-- index on `(user_id, kind, subject_id)` absorbs the repeat), gives the member
-- an in-app record, and lets the next digest pick up anything the immediate
-- send did not get to.
--
-- WHAT CHANGES. Two CHECK constraints widen by one value each, and nothing
-- else:
--
--   * `kind` admits `membership_plan_open`;
--   * `subject_type` admits `membership_plan_announcement`. The subject is one
--     announcement, not the plan, because a plan can be announced more than
--     once (a manager may announce it again after a price change), and the
--     unique index would otherwise refuse the second one. `subject_id` is the
--     announcement's own id, which the caller mints; like every other
--     `subject_id` it is deliberately not a foreign key.
--
-- No new table, column, function, policy or grant. The column types do not
-- change, so the generated Supabase types do not change either.
--
-- SEQUENCING. Additive: every value the old constraint accepted, the new one
-- still accepts, so the code live today is unaffected. It has to be live BEFORE
-- the code that writes the new kind is deployed, or every announcement fails at
-- its first insert (`docs/database-changes.md`). Nothing here applies it: it
-- waits for the pull request to be approved.
--
-- The constraint names are the ones Postgres generated for the inline CHECKs in
-- `20260806030000_notifications.sql`; no migration since has renamed them.
-- Read live on 2026-10-23 (pg_constraint, SELECT only): both exist under these
-- names, each still holding exactly the values that file gave it.

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_kind_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_kind_check CHECK (
    kind IN (
      'reply',
      'thread_activity',
      'new_blog_post',
      'blog_comment',
      'kb_comment',
      'membership_plan_open'
    )
  );

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_subject_type_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_subject_type_check CHECK (
    subject_type IN (
      'blog_comment',
      'kb_annotation',
      'blog_post',
      'membership_plan_announcement'
    )
  );
