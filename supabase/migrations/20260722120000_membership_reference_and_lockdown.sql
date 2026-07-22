-- Membership hardening + stable, human-friendly payment references.
--
-- 1. SECURITY (price-forge fix). The original member INSERT policy validated
--    user_id/status/student-number but NOT price_cents, so a member could insert
--    a pending row for a real plan at price_cents = 1, transfer 1 cent, and have
--    bank reconciliation auto-activate it. All real inserts already go through
--    the service-role `startMembership` server function (which computes the price
--    server-side), so remove the member-facing INSERT path entirely.
DROP POLICY IF EXISTS "Users can create their own membership" ON public.memberships;
REVOKE INSERT ON public.memberships FROM authenticated;

-- 2. Stable per-member references. The reference is now derived deterministically
--    from the member (surname + a stable code, plus the session date for casual
--    drop-ins), so a member reuses the same reference across memberships and it
--    can no longer be globally unique. Drop the UNIQUE constraint, keep a plain
--    index for lookup, and add the per-session date.
ALTER TABLE public.memberships DROP CONSTRAINT IF EXISTS memberships_payment_reference_key;
CREATE INDEX IF NOT EXISTS memberships_payment_reference_idx
  ON public.memberships (payment_reference);
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS session_date DATE;
