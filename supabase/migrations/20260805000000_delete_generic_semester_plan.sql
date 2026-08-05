-- Delete the leftover generic "One semester" plan (code 'semester').
--
-- It predates "membership plans carry their own dates": back when a plan was a
-- price and `club_semesters` supplied the dates, one generic row covered every
-- semester. Since 20260804000000 each semester is its own dated plan
-- ('2026-s1', '2026-s2', ...), so this row is a `period` plan with no dates at
-- all -- it can never be sold, and it shows up on the manager screen as an
-- inexplicable entry with nothing in it.
--
-- 20260804000000 deactivated rather than deleted it, on the precaution that
-- invoices sold against it would still need to resolve `plan_id`. Queried
-- since: no `memberships` row references it, so that precaution costs nothing
-- to discharge and the row can go.
--
-- The NOT EXISTS guard re-checks that at apply time rather than trusting the
-- reading taken while writing this: if somebody buys it in between, the delete
-- becomes a no-op instead of failing on `memberships.plan_id`'s foreign key
-- (NOT NULL, no ON DELETE). The RAISE below makes that outcome visible, since
-- a silent no-op would otherwise leave the plan on the manager screen forever
-- while the docs claim it is gone.

DELETE FROM public.membership_plans
WHERE code = 'semester'
  AND NOT EXISTS (
    SELECT 1 FROM public.memberships m WHERE m.plan_id = membership_plans.id
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.membership_plans WHERE code = 'semester') THEN
    RAISE WARNING 'Plan ''semester'' was NOT deleted: memberships still reference it. Retire it by hand.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
