-- Session check-ins: who was on the mat, and what paid for it.
--
-- A manager checks people in against a DATE ON THE CALENDAR (`calendar_events`),
-- and the check-in is what finally spends `memberships.sessions_remaining` —
-- until now that column was written once at activation and never read down, so a
-- two-session free trial lasted forever. A trial or session-pack credit is
-- consumed; an unlimited period membership covers whatever credits cannot.
--
-- When nothing covers it the check-in STILL HAPPENS, flagged `coverage = 'none'`
-- and collected in the manager's "needs attention" list to be attached to a
-- membership later. The person was on the mat either way, and the door is not
-- the place to have a payment argument: a refused check-in loses that fact
-- permanently, whereas an uncovered one is two clicks from correct.
--
-- Only people with a waiver on file can be checked in, so `user_id` references
-- `profiles` rather than `auth.users` — the product rule is a foreign key
-- instead of a check somewhere in application code. There are no guest rows and
-- no free-text names.
--
-- This recreates the design recorded in the comment of
-- `20260728170000_drop_session_checkins.sql`, which dropped an orphaned table
-- that had been created directly against production. Five things are changed
-- from that note, each because the original spec had a failure mode:
--   * `coverage` mirrors `membership_plans.kind` (+ 'none') instead of inventing
--     a second vocabulary ('member', 'pass'); 'pending' is gone because it was a
--     state, not a source of cover, and duplicated `membership_id IS NULL`.
--   * `checked_in_at`, `consumed_credit` and `warnings` are NOT NULL. A check-in
--     with no time is not a check-in, and a nullable boolean is a third state
--     every reader would have to invent a meaning for.
--   * `closed_membership` is new: undo has to reverse exactly what the check-in
--     did, and without it undo would have to guess from "expired with 0 credits"
--     and would wrongly reopen a membership a manager expired by hand.
--   * The standalone `(event_id)` and `(checked_in_at)` indexes are gone. The
--     UNIQUE index already leads on `event_id`, and no query orders by
--     `checked_in_at` globally except the needs-attention list, which gets a
--     partial index instead.

CREATE TABLE public.session_checkins (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- CASCADE: an event deleted outright never happened. Cancelling keeps the row
  -- (`status = 'cancelled'`), so a cancelled class keeps its attendance record;
  -- only a real delete takes the check-ins with it.
  event_id UUID NOT NULL REFERENCES public.calendar_events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_in_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- What covered the class AT THE TIME, mirroring `membership_plans.kind`. This
  -- is stored rather than derived through `membership_id` for the same reason a
  -- waiver freezes its submission: a manager may edit a plan's kind afterwards,
  -- and that must not rewrite what happened. 'insurance' is absent on purpose —
  -- yearly insurance is affiliation and cover, never mat time.
  coverage TEXT NOT NULL DEFAULT 'none'
    CHECK (coverage IN ('trial', 'session', 'period', 'none')),
  membership_id UUID REFERENCES public.memberships(id) ON DELETE SET NULL,
  consumed_credit BOOLEAN NOT NULL DEFAULT false,
  -- This check-in took the membership's LAST credit and closed it
  -- (status -> 'expired'). Undo reads this to know what it has to reverse.
  closed_membership BOOLEAN NOT NULL DEFAULT false,
  -- Stable machine codes (`checkInWarnings` in src/lib/validation.ts), never
  -- sentences: the wording is the UI's job and must not need a migration.
  warnings TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  note TEXT,
  -- One check-in per person per class. This is not tidiness, it is half the
  -- concurrency guard: two managers tapping the same name, or one manager
  -- double-tapping, race here and exactly one wins. The server inserts FIRST and
  -- lets 23505 pick the loser, rather than reading then writing across a
  -- multi-second window. The other half is in the server: attaching cover to an
  -- EXISTING row cannot be guarded here, so that path claims the row with
  -- `WHERE coverage = 'none'` and refunds if it loses.
  CONSTRAINT session_checkins_one_per_event UNIQUE (event_id, user_id),
  -- Uncovered means unattached. The converse is deliberately NOT asserted:
  -- `membership_id` is ON DELETE SET NULL, and a biconditional would make
  -- deleting a membership fail on a CHECK violation.
  CONSTRAINT session_checkins_uncovered_has_no_membership
    CHECK (coverage <> 'none' OR membership_id IS NULL),
  -- There is deliberately NO `consumed_credit = false OR membership_id IS NOT
  -- NULL` here, for the same reason. ON DELETE SET NULL runs an UPDATE on this
  -- row, CHECKs are re-evaluated on UPDATE, and such a constraint would abort
  -- any `DELETE FROM memberships` whose credits had ever been spent — with a
  -- cryptic error and no way through, in the dashboard where a manager cleans
  -- up a bad invoice. The write path already guarantees the pairing; what
  -- survives a deleted membership is an honest "a credit was spent, from a
  -- membership that no longer exists".
  CONSTRAINT session_checkins_close_needs_credit
    CHECK (closed_membership = false OR consumed_credit = true)
);

-- Per-person attendance count (/manager/users, the person page, /membership).
CREATE INDEX session_checkins_user_id_idx ON public.session_checkins (user_id);

-- The "needs attention" list: every uncovered check-in, newest first. Partial,
-- because it is the only query that scans across events and it is normally a
-- handful of rows out of everything ever recorded.
CREATE INDEX session_checkins_uncovered_idx
  ON public.session_checkins (checked_in_at DESC)
  WHERE coverage = 'none';

-- ---------- Grants ----------
-- Supabase's bootstrap grants ALL on every new table in `public` to anon and
-- authenticated, and GRANT cannot narrow that — only REVOKE can, so the REVOKE
-- has to come first (docs/database-changes.md). Nothing here is reached from a
-- browser or from an anon-key server client: every read and write goes through a
-- manager-only server function on the service role, so the client roles get
-- nothing, and `supabase/lint/client-grants-expected.txt` needs no entry.
REVOKE ALL ON public.session_checkins FROM anon, authenticated;
GRANT ALL ON public.session_checkins TO service_role;

ALTER TABLE public.session_checkins ENABLE ROW LEVEL SECURITY;

-- Defence in depth, exactly like `event_rsvps`: with no client grant these are
-- unreachable, and they are already correct on the day someone adds one. The
-- REVOKE above is the live access rule, not these.
CREATE POLICY "Managers can read all check-ins" ON public.session_checkins
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Users can view their own check-ins" ON public.session_checkins
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Managers can insert check-ins" ON public.session_checkins
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can update check-ins" ON public.session_checkins
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can delete check-ins" ON public.session_checkins
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'manager'));

NOTIFY pgrst, 'reload schema';
