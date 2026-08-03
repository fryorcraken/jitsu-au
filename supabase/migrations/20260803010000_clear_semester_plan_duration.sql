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
-- ============================================================================
-- APPLY ORDER -- this one deliberately breaks the repo's usual apply-then-
-- merge sequence. Do NOT apply this migration as part of the normal
-- apply -> merge flow (docs/database-changes.md), because at that point the
-- OLD code is still live (Lovable deploys from `main`, which only happens
-- AFTER this PR merges) and the old activateMembershipRow reads
-- `plan.duration_days` directly with no period_basis check: clearing it while
-- that code is still serving reproduces the exact never-expires bug this
-- split exists to avoid. The `WHERE period_basis = 'semester'` guard does NOT
-- protect against this -- that column was already set by the prior,
-- already-merged migration, so the predicate is true regardless of whether
-- THIS PR's code has deployed.
--
-- Correct order: 1) merge this PR, 2) confirm the new activateMembershipRow
-- (src/lib/membership.functions.ts, the branch on `period_basis === "semester"`
-- reading `club_semesters`) is actually live, 3) only then apply this file,
-- record it in the ledger, and reload PostgREST.
-- ============================================================================
UPDATE public.membership_plans
  SET duration_days = NULL
  WHERE code = 'semester' AND period_basis = 'semester';

NOTIFY pgrst, 'reload schema';
