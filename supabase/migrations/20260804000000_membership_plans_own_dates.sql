-- Membership plans carry their own dates and price: expand phase.
--
-- `club_semesters` modelled the club's training periods as a thing separate
-- from the plan that sells them: a `code` format that only permits two
-- periods a year (`^[0-9]{4}-s[12]$`), a `year`/`half` pair, its own overlap
-- constraint, and a `memberships.semester_id` column every `period` plan
-- membership had to look up at activation time. Adding a differently-shaped
-- plan (a yearly membership, say) meant touching that whole path.
--
-- This migration removes the separation. A `period` plan now carries its own
-- `starts_on`/`ends_on` directly: everyone who buys that plan gets exactly
-- those dates, the same rule `club_semesters` enforced, with no second table.
-- Adding next year's plan is a new `membership_plans` row with its own dates
-- and its own price — no code change, and no format assumption about how many
-- periods a year the club runs.
--
-- `duration_days` is kept, not dropped: it is now the *rolling* half of the
-- same discriminator `period_basis` used to be (`insurance_yearly` runs 365
-- days from payment, exactly as it always has). A plan sets `starts_on`/
-- `ends_on` XOR `duration_days` XOR neither (trial/casual, which end with
-- their credits) — enforced below, not by an app-level `kind` switch.
--
-- This is the EXPAND half. The CONTRACT half — dropping `club_semesters`,
-- `memberships.semester_id` and `membership_plans.period_basis`, and revoking
-- `membership_plans`'s now-unused anon grant — waits in a later migration
-- until the code that reads them is confirmed off the live site (see
-- docs/database-changes.md).

-- ---------- membership_plans: starts_on / ends_on ----------
ALTER TABLE public.membership_plans
  ADD COLUMN IF NOT EXISTS starts_on DATE,
  ADD COLUMN IF NOT EXISTS ends_on DATE;

ALTER TABLE public.membership_plans
  ADD CONSTRAINT membership_plans_dates_paired
    CHECK ((starts_on IS NULL) = (ends_on IS NULL)),
  ADD CONSTRAINT membership_plans_dates_order
    CHECK (ends_on >= starts_on),
  -- A plan is EITHER a fixed date range OR a rolling duration from payment,
  -- never both — there would be no rule for which one wins at activation.
  ADD CONSTRAINT membership_plans_dates_xor_duration
    CHECK (NOT (starts_on IS NOT NULL AND duration_days IS NOT NULL));

-- ---------- Backfill: one plan per existing club_semesters row ----------
-- Each semester becomes its own `period` plan, carrying the generic
-- `semester` plan's price/description/session_credits but its own code,
-- name and dates. Existing memberships are repointed at it so their invoice
-- names the actual period they bought, not a generic "One semester" plan.
INSERT INTO public.membership_plans
  (code, name, description, kind, public_price_cents, student_price_cents,
   duration_days, session_credits, is_active, sort_order, starts_on, ends_on)
SELECT
  cs.code,
  cs.name,
  sp.description,
  'period',
  sp.public_price_cents,
  sp.student_price_cents,
  NULL,
  sp.session_credits,
  cs.is_active,
  sp.sort_order,
  cs.starts_on,
  cs.ends_on
FROM public.club_semesters cs
CROSS JOIN (SELECT * FROM public.membership_plans WHERE code = 'semester') sp
ON CONFLICT (code) DO NOTHING;

UPDATE public.memberships m
SET plan_id = np.id
FROM public.club_semesters cs
JOIN public.membership_plans np ON np.code = cs.code
WHERE m.semester_id = cs.id;

-- The generic plan stays (invoices already sold against it still need to
-- resolve `plan_id`), but it is no longer for sale: every dated successor now
-- has its own plan row.
UPDATE public.membership_plans SET is_active = false WHERE code = 'semester';

NOTIFY pgrst, 'reload schema';
