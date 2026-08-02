-- Club semesters: the club's own fixed training dates for each UTS half-year.
--
-- The `semester` membership plan has always run as a 182-day rolling window
-- starting the instant payment clears (activateMembershipRow: `ends_at = now +
-- duration_days`). That is not a semester. The club's semester is a fixed from
-- and to date, aligned with (but not identical to) the UTS teaching calendar,
-- and it moves by roughly a week every year. It cannot be derived, so it needs
-- somewhere to be recorded.
--
-- This migration is schema only:
--   * `club_semesters` is the new table of fixed date ranges.
--   * `membership_plans.period_basis` is an explicit discriminator between a
--     rolling-window plan (`insurance_yearly`, which genuinely is "12 months
--     from whenever you paid") and a semester-anchored plan (`semester`).
--     `duration_days IS NULL` already means "no expiry at all" for the trial
--     and casual plans, so it cannot also stand in for "look up the semester".
--   * `memberships.semester_id` records which semester a semester-plan
--     membership was bought for.
--
-- No semester rows are seeded here. The club's own dates are entered on the
-- manager Semesters screen once this ships, not hardcoded into a migration.
--
-- Named `club_semesters`, not "terms" or "sessions": this codebase already uses
-- "session" for one class (`session_checkins`, `sessions_remaining`,
-- `session_credits`, `session_date`, coverage source `"session"`), and reusing
-- it for an academic term would be actively misleading.

-- ---------- club_semesters ----------
CREATE TABLE public.club_semesters (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Stable key used by the purchase flow and the manager agent API, e.g.
  -- '2026-s1'. Not the primary key so it can be validated with a plain regex
  -- rather than trusting whatever shape a UUID happens to have.
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[0-9]{4}-s[12]$'),
  name TEXT NOT NULL,
  year INT NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  half SMALLINT NOT NULL CHECK (half IN (1, 2)),
  starts_on DATE NOT NULL,
  -- Inclusive: the last day of training, not midnight before it.
  ends_on DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT club_semesters_order_ok CHECK (ends_on >= starts_on),
  CONSTRAINT club_semesters_year_half_unique UNIQUE (year, half),
  -- `code` is derived from `year`/`half` everywhere the app writes it, but
  -- nothing stops the two from being written inconsistently by hand (or by a
  -- future bug) without this: UNIQUE(code) and UNIQUE(year, half) each hold on
  -- their own even if a row's code says '2026-s1' while its year/half say
  -- 2027/2.
  CONSTRAINT club_semesters_code_matches_year_half
    CHECK (code = year::text || '-s' || half::text),
  -- `starts_on`/`ends_on` are the only columns that determine what a member
  -- actually gets; nothing else here guards them. Without this, a mistyped
  -- year in the date picker (e.g. code '2026-s1' running Sept-Dec *2045*)
  -- would sail through every other constraint on this table.
  CONSTRAINT club_semesters_dates_in_year CHECK (
    EXTRACT(YEAR FROM starts_on) = year AND EXTRACT(YEAR FROM ends_on) = year
  )
);

-- Two semesters can never overlap: an ambiguous "which semester is running
-- now" would silently break the purchase list (`sellableSemesters`), which
-- assumes at most one semester covers any given day. Deliberately NOT scoped
-- to `is_active` -- `UNIQUE(code)` and `UNIQUE(year, half)` already make
-- "retire the wrong one, insert its correction" impossible (there is never a
-- second row for the same year+half to overlap with), so a partial predicate
-- here would buy nothing while opening a real trap: reactivating a semester
-- would fail if anything else had since been given its date range. `daterange`
-- carries its own built-in GiST operator class, so no extension is needed here.
ALTER TABLE public.club_semesters
  ADD CONSTRAINT club_semesters_no_overlap
  EXCLUDE USING gist (daterange(starts_on, ends_on, '[]') WITH &&);

-- ---------- Grants ----------
-- Supabase's bootstrap grants ALL on every new table to anon and authenticated,
-- and GRANT cannot narrow that -- only REVOKE can, so REVOKE comes first
-- (docs/database-changes.md).
--
-- Anon SELECT is required, not defensive: the pricing page's loader and the
-- member purchase flow read plans through `serverSupabase()` in
-- membership.functions.ts, which builds its own client from
-- SUPABASE_PUBLISHABLE_KEY with no user session, so PostgREST resolves it to
-- `anon` even though it runs on the server. That is the exact trap
-- docs/database-changes.md calls out under "table grants". Writes stay
-- service-role only, through the manager server functions.
REVOKE ALL ON public.club_semesters FROM anon, authenticated;
GRANT SELECT ON public.club_semesters TO anon, authenticated;
GRANT ALL ON public.club_semesters TO service_role;

ALTER TABLE public.club_semesters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active semesters" ON public.club_semesters
  FOR SELECT USING (is_active = true);
CREATE POLICY "Managers can read all semesters" ON public.club_semesters
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));

-- ---------- membership_plans.period_basis ----------
ALTER TABLE public.membership_plans
  ADD COLUMN IF NOT EXISTS period_basis TEXT NOT NULL DEFAULT 'rolling'
    CHECK (period_basis IN ('rolling', 'semester'));

-- The one plan this actually changes. `insurance_yearly` is left as 'rolling'
-- (the default): a 12-month membership genuinely does run from whenever it was
-- paid, unlike a semester.
--
-- `duration_days` deliberately stays at 182 here rather than being cleared to
-- NULL in the same statement. This migration is additive-only and ships ahead
-- of the code that reads `period_basis`; today `activateMembershipRow` still
-- computes `ends_at` straight from `plan.duration_days` regardless of
-- `period_basis`. Clearing it now would mean any semester membership
-- activated in the window between this migration going live and the
-- follow-up PR deploying gets `ends_at = NULL` -- which this app's `isLive`/
-- `resolveCoverage` treat as "never expires", handing out a free membership
-- forever. Per docs/database-changes.md's expand/contract split: clearing
-- `duration_days` is the CONTRACT half, and it belongs in the follow-up PR's
-- migration, applied only after the code that stops reading it for this plan
-- is live.
UPDATE public.membership_plans
  SET period_basis = 'semester'
  WHERE code = 'semester';

-- ---------- memberships.semester_id ----------
-- Plain REFERENCES with no ON DELETE clause (NO ACTION, the default):
-- deleting a semester that invoices point at must fail loudly, never orphan
-- or cascade into losing which semester someone paid for.
ALTER TABLE public.memberships
  ADD COLUMN IF NOT EXISTS semester_id UUID REFERENCES public.club_semesters(id);
CREATE INDEX IF NOT EXISTS memberships_semester_id_idx ON public.memberships (semester_id);

NOTIFY pgrst, 'reload schema';
