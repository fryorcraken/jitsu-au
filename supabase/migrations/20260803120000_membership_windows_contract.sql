-- Contract phase of the membership-windows UX simplification: drop the two
-- columns the redesigned catalogue no longer reads.
--
-- `duration_days` is gone because every remaining kind computes its dates a
-- different way: `period` (membership) runs the window the member picked on
-- `club_semesters`, `insurance` runs a fixed 365 days from payment in code,
-- and `trial`/`session` never had meaningful expiry dates. `period_basis` is
-- gone because there is nothing left to discriminate: a `period` plan is
-- window-anchored, always.
--
-- ============================================================================
-- APPLY ORDER -- CONTRACT phase, deliberately after the code.
-- Do NOT apply this while the pre-redesign code is live: the old
-- activateMembershipRow reads `plan.duration_days` directly and the old
-- saveMembershipPlan writes both columns, so dropping them early breaks the
-- currently deployed build. Correct order: 1) merge and deploy the redesign PR,
-- 2) confirm the new code is serving, 3) apply this file, record it in the
-- ledger, reload PostgREST. Until then it stays in
-- supabase/lint/migration-drift-allowlist.txt. See
-- docs/database-changes.md (expand/contract).
-- ============================================================================
ALTER TABLE public.membership_plans DROP COLUMN duration_days;
ALTER TABLE public.membership_plans DROP COLUMN period_basis;

NOTIFY pgrst, 'reload schema';
