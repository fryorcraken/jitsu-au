-- Membership plans carry their own dates and price: contract phase.
--
-- Drops the machinery the redesign in 20260804000000_membership_plans_own_dates
-- replaced: `club_semesters`, `memberships.semester_id`, and
-- `membership_plans.period_basis`. Every remaining plan now discriminates its
-- own duration via `starts_on`/`ends_on` XOR `duration_days` XOR neither, so
-- there is nothing left to look up in a second table and nothing left for
-- `period_basis` to discriminate.
--
-- Also revokes `membership_plans`'s anon SELECT grant: the public pricing page
-- (`/pricing`) is deliberately decoupled from the live catalogue in this same
-- change (a marketing page cannot show two different prices when two dated
-- plans are on sale at once — see docs/memberships.md), so `anon` was its only
-- reader and nothing anonymous reads this table anymore. `listMembershipPlans`
-- moves behind `requireSupabaseAuth` in the same PR.
--
-- ============================================================================
-- APPLY ORDER — deliberately after the code, per docs/database-changes.md's
-- expand/contract split. The old build's `activateMembershipRow` still reads
-- `membership.semester_id` and `club_semesters` directly, and the old
-- `listMembershipPlans` is read anonymously by the still-live `/pricing`
-- loader. Dropping any of this while that code is still deployed breaks it.
--
-- Correct order: 1) merge this PR, 2) confirm the new code (the
-- `planMembershipWindow`-based activation, and the decoupled `/pricing`) is
-- actually live, 3) only then apply this file, record it in the ledger, and
-- reload PostgREST. Until then it stays in
-- supabase/lint/migration-drift-allowlist.txt.
--
-- Applying this file also retires two lines in
-- supabase/lint/client-grants-expected.txt (`membership_plans:anon:SELECT` and
-- both `club_semesters:*` lines) — update that file in the SAME step you apply
-- this migration, not before: check-client-grants.py checks the live ACL, and
-- removing the lines earlier would fail the very next push-to-main run while
-- this REVOKE still sits unapplied.
-- ============================================================================

REVOKE SELECT ON public.membership_plans FROM anon;

ALTER TABLE public.membership_plans DROP COLUMN period_basis;
ALTER TABLE public.memberships DROP COLUMN semester_id;
DROP TABLE public.club_semesters;

NOTIFY pgrst, 'reload schema';
