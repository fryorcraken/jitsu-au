-- Delete the leftover generic "One semester" plan (code 'semester').
--
-- It predates "membership plans carry their own dates": back when a plan was a
-- price and `club_semesters` supplied the dates, one generic row covered every
-- semester. Since 20260804000000 each semester is its own dated plan
-- ('2026-s1', '2026-s2', ...), so this row is a `period` plan with no dates at
-- all -- it can never be sold, and it shows up on the manager screen as an
-- inexplicable entry with nothing in it.
--
-- Verified before writing this: it is already `is_active = false` and no
-- `memberships` row has ever referenced it, so nothing is lost. The NOT EXISTS
-- guard keeps that true at apply time rather than at authoring time: if
-- somebody does buy it in between, this becomes a no-op instead of failing on
-- `memberships.plan_id`'s foreign key (NOT NULL, no ON DELETE), and the row can
-- be retired by hand instead.

DELETE FROM public.membership_plans
WHERE code = 'semester'
  AND NOT EXISTS (
    SELECT 1 FROM public.memberships m WHERE m.plan_id = membership_plans.id
  );

NOTIFY pgrst, 'reload schema';
