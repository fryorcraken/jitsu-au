-- Memberships: plan catalog, member enrollments, and bank reconciliation.
--
-- Turns the club's fees (yearly insurance, 2-session trial, casual per-session,
-- and semester time-period) into a trackable membership system with:
--   * a UTS student discount (trust-based: the student rate applies whenever a
--     UTS student number is supplied; the number is REQUIRED to take it),
--   * a trial -> member user lifecycle (the `member` role is granted when a paid
--     membership activates), and
--   * bank-transfer payment reconciled via a unique payment reference.
-- Money is stored as integer cents. Stripe is a future add — `payment_method`
-- already allows it, and activation is a single code path.

-- ---------- membership_plans (manager-editable catalog) ----------
CREATE TABLE public.membership_plans (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('insurance', 'trial', 'session', 'period')),
  public_price_cents INT NOT NULL CHECK (public_price_cents >= 0),
  student_price_cents INT CHECK (student_price_cents >= 0),
  duration_days INT CHECK (duration_days > 0),
  session_credits INT CHECK (session_credits > 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.membership_plans TO anon, authenticated;
GRANT INSERT, UPDATE ON public.membership_plans TO authenticated;
GRANT ALL ON public.membership_plans TO service_role;

ALTER TABLE public.membership_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active plans" ON public.membership_plans
  FOR SELECT USING (is_active = true);
CREATE POLICY "Managers can read all plans" ON public.membership_plans
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can insert plans" ON public.membership_plans
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can update plans" ON public.membership_plans
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- Seed the four current plans (prices mirror src/routes/pricing.tsx).
INSERT INTO public.membership_plans
  (code, name, description, kind, public_price_cents, student_price_cents, duration_days, session_credits, sort_order)
VALUES
  ('trial_2_session', 'Free trial',
   'Your first two sessions, free all year round.',
   'trial', 0, NULL, NULL, 2, 0),
  ('casual_session', 'Casual class',
   'Drop in to any regular class, no commitment.',
   'session', 3000, 2000, NULL, 1, 1),
  ('semester', 'One semester',
   'Unlimited classes for a UTS half-year. Grading fee included.',
   'period', 44500, 24500, 182, NULL, 2),
  ('insurance_yearly', 'Sydney Jitsu yearly membership',
   'Insurance & club affiliation, valid 12 months.',
   'insurance', 6000, NULL, 365, NULL, 3);

-- ---------- memberships (enrollment records) ----------
CREATE TABLE public.memberships (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  plan_id UUID NOT NULL REFERENCES public.membership_plans(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'expired', 'cancelled')),
  is_student BOOLEAN NOT NULL DEFAULT false,
  uts_student_number TEXT,
  price_cents INT NOT NULL CHECK (price_cents >= 0),
  payment_reference TEXT NOT NULL UNIQUE,
  payment_method TEXT NOT NULL DEFAULT 'bank_transfer'
    CHECK (payment_method IN ('bank_transfer', 'stripe', 'manual')),
  paid_at TIMESTAMPTZ,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  sessions_remaining INT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The student rate can only be taken with a UTS student number on file.
  CONSTRAINT memberships_student_number_required CHECK (
    is_student = false
    OR (uts_student_number IS NOT NULL AND length(btrim(uts_student_number)) > 0)
  )
);

CREATE INDEX memberships_user_id_idx ON public.memberships (user_id);
CREATE INDEX memberships_status_idx ON public.memberships (status);

GRANT SELECT, INSERT, UPDATE ON public.memberships TO authenticated;
GRANT ALL ON public.memberships TO service_role;

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own memberships" ON public.memberships
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Managers can view all memberships" ON public.memberships
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
-- Defense in depth: the server function creates rows with the service role, but
-- if a member ever writes directly, they may only create their own PENDING row.
CREATE POLICY "Users can create their own membership" ON public.memberships
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND status = 'pending'
    AND price_cents >= 0
    AND (
      is_student = false
      OR (uts_student_number IS NOT NULL AND length(btrim(uts_student_number)) > 0)
    )
  );
CREATE POLICY "Managers can update memberships" ON public.memberships
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- ---------- bank_transactions (statement import + reconciliation) ----------
CREATE TABLE public.bank_transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  import_batch UUID NOT NULL,
  posted_at DATE,
  amount_cents INT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reference TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Content hash so re-importing the same statement is idempotent.
  dedupe_hash TEXT NOT NULL UNIQUE,
  matched_membership_id UUID REFERENCES public.memberships(id) ON DELETE SET NULL,
  matched_at TIMESTAMPTZ,
  matched_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'unmatched'
    CHECK (status IN ('unmatched', 'matched', 'ignored')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bank_transactions_status_idx ON public.bank_transactions (status);

GRANT SELECT ON public.bank_transactions TO authenticated;
GRANT ALL ON public.bank_transactions TO service_role;

ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can view bank transactions" ON public.bank_transactions
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
