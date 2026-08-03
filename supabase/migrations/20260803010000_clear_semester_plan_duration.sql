-- Contract phase of the semester-membership change: clear the `semester`
-- plan's `duration_days` now that the code has stopped reading it.
--
-- The additive migration (20260802110000_club_semesters.sql) deliberately left
-- `duration_days` at 182 rather than clearing it in the same statement that
-- added `period_basis`, because it shipped ahead of the code that reads
-- `period_basis` -- clearing it there would have handed out never-expiring
-- semester memberships to anyone who activated one in the gap between that
-- migration going live and this code deploying (see that file's `UPDATE`
-- comment, and docs/database-changes.md's expand/contract split).
--
-- That code is now live: `activateMembershipRow` (src/lib/membership.functions.ts)
-- computes a semester-anchored plan's `starts_at`/`ends_at` from the
-- `club_semesters` row chosen at purchase whenever `period_basis = 'semester'`,
-- never from `duration_days`. This is the deferred second half: nothing can
-- fall back to the old 182-day computation for this plan any more.
UPDATE public.membership_plans
  SET duration_days = NULL
  WHERE code = 'semester' AND period_basis = 'semester';

NOTIFY pgrst, 'reload schema';
