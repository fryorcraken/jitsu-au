-- Make a re-sent form submission recognisable as the SAME submission.
--
-- Why this exists
-- ---------------
-- The public forms had no timeout and no retry: a stalled connection left the
-- button spinning forever, and a dropped reply looked exactly like a failure
-- even when the row had already been written. The fix is to retry hard (see
-- src/lib/submit-resilience.ts) and to ask the server whether the work landed
-- rather than guessing (checkWaiverSubmission).
--
-- Neither is safe without this column. Aborting a client request does NOT stop
-- the server, so any automatic retry can race a first attempt that is still
-- committing. Without a key to recognise, that means a duplicate lead, or a
-- duplicate SIGNED WAIVER plus a second round of emails to the member and every
-- manager. The client mints one uuid per form fill and sends it on every
-- attempt; the server treats a repeat as "already recorded".
--
-- Shape
-- -----
-- Nullable, with a PARTIAL unique index. Every existing row is NULL and stays
-- legal (a plain UNIQUE would also allow that, but the partial index keeps the
-- intent explicit and the index small). An older cached client that sends no id
-- still submits, it just gets no dedupe protection — which is exactly the
-- behaviour it has today.
--
-- Grants and RLS
-- --------------
-- No changes needed, and none are made:
--
--   * These are EXISTING tables. A new column inherits the table's privileges,
--     and column-level grants are not used anywhere in this schema, so
--     supabase/lint/client-grants-expected.txt is unaffected. `anon` keeps
--     INSERT-only on the two intake tables (20260728150000).
--   * The INSERT policies in 20260720160419 enumerate named columns in their
--     WITH CHECK (name/email/message lengths and so on) and do not constrain
--     columns they do not mention, so they keep passing unchanged.
--   * `waivers` is written by the service-role client, which bypasses RLS.
--
-- Reads
-- -----
-- interest_registrations and contact_messages are written as `anon`, which has
-- no SELECT here (deliberately — a lead must not be readable from the client).
-- So those two handlers detect a repeat from the unique violation (SQLSTATE
-- 23505) rather than by looking first. `waivers` is service-role, so it can and
-- does look the id up before doing any work.

ALTER TABLE public.interest_registrations
  ADD COLUMN IF NOT EXISTS client_submission_id UUID;

ALTER TABLE public.contact_messages
  ADD COLUMN IF NOT EXISTS client_submission_id UUID;

ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS client_submission_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS interest_registrations_client_submission_id_key
  ON public.interest_registrations (client_submission_id)
  WHERE client_submission_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contact_messages_client_submission_id_key
  ON public.contact_messages (client_submission_id)
  WHERE client_submission_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS waivers_client_submission_id_key
  ON public.waivers (client_submission_id)
  WHERE client_submission_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
