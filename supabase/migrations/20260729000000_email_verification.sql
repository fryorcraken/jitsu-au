-- Email verification: prove a person can actually read the address we hold.
--
-- The email IS the person here (one address, one person, one profile), and it is
-- typed by hand into a public waiver form. A typo produces a person record
-- attached to a mailbox nobody reads: the approval flow emails a sign-in link
-- that goes nowhere, and no screen can tell that apart from "check your spam".
--
-- "Verified" means exactly one thing: someone opened a link we sent to that
-- address. That state is NOT stored here — it lives on `auth.users.email_confirmed_at`,
-- which Supabase already stamps natively on a magic-link sign-in. This migration
-- adds the three things the app needs around it:
--   1. a table of hashed proof-of-click tokens,
--   2. a way to READ the confirmation stamp (extends `user_emails`),
--   3. a way to CLEAR it (when a manager corrects an address).

-- ---------- email_verification_tokens ----------
-- Same pattern as manager_api_tokens / calendar_feed_tokens: only the SHA-256
-- hash is stored, and the raw token rides in a URL path because an email client
-- cannot send an Authorization header.
--
-- Two things differ from those tables, both deliberate:
--
--   * `user_id` is NULLABLE. A token is minted for an interest registration
--     (a LEAD), and a lead has no person record yet. The token binds to the
--     ADDRESS; when that person is created at waiver submission, the proof is
--     applied to them then. Binding to a user id would make the highest-value
--     case impossible.
--   * Tokens are REUSABLE, not single-use. The interest email's token also rides
--     on the waiver prefill link, which people come back to; and verification is
--     idempotent, so a second click costs nothing. `last_used_at` records the
--     most recent redemption rather than burning the row.
CREATE TABLE public.email_verification_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Null while the address has no person record yet (a lead).
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The address this token proves, normalized. A token NEVER verifies any other
  -- address: if the account's email has since changed, redemption is a no-op.
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT email_verification_tokens_purpose_check CHECK (
    purpose IN ('interest', 'waiver', 'manager_resend', 'self_resend', 'email_change')
  ),
  -- Stored normalized so a lookup never has to case-fold.
  CONSTRAINT email_verification_tokens_email_check CHECK (
    char_length(email) BETWEEN 3 AND 255 AND email = lower(btrim(email))
  )
);

-- The redemption hot path: hash -> live row.
CREATE INDEX email_verification_tokens_live_idx
  ON public.email_verification_tokens (token_hash)
  WHERE revoked_at IS NULL;

-- Revoking every live token for an address (a manager corrected the email).
CREATE INDEX email_verification_tokens_email_idx
  ON public.email_verification_tokens (email)
  WHERE revoked_at IS NULL;

-- Service role only. Unlike calendar_feed_tokens there is nothing here a person
-- needs to see about their own row, so RLS is enabled with NO policies and no
-- client grants at all: anon and authenticated cannot reach this table, and
-- minting/redeeming/revoking all run through the server.
ALTER TABLE public.email_verification_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_verification_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.email_verification_tokens TO service_role;

-- ---------- read the confirmation stamp ----------
-- `user_emails` gains `email_confirmed_at` so manager screens can show verified
-- state in the same round trip that resolves the address.
--
-- CREATE OR REPLACE cannot change a RETURNS TABLE shape, so this drops and
-- recreates. Same name, same arguments, a superset of columns: already-deployed
-- code selecting (user_id, email) keeps working, which is what makes this an
-- ADDITIVE change for deploy-ordering purposes.
DROP FUNCTION IF EXISTS public.user_emails(UUID[]);

CREATE FUNCTION public.user_emails(_user_ids UUID[])
RETURNS TABLE (user_id UUID, email TEXT, email_confirmed_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Table-qualified: the RETURNS TABLE columns are OUT parameters and would
  -- otherwise shadow the auth.users columns of the same name.
  SELECT u.id, u.email::text, u.email_confirmed_at
  FROM auth.users u
  WHERE u.id = ANY(_user_ids)
$$;

REVOKE EXECUTE ON FUNCTION public.user_emails(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_emails(UUID[]) TO service_role;

-- ---------- clear the confirmation stamp ----------
-- Changing someone's address must always drop them back to unverified: the new
-- address has never been proven, whatever was true of the old one.
--
-- The auth admin API can SET a confirmation (`email_confirm: true`) but does not
-- reliably CLEAR one, so the server calls this immediately after an email
-- change. That is what makes "edit means unverified" a guarantee rather than a
-- hope about GoTrue's behaviour.
--
-- Only `email_confirmed_at` is touched. `auth.users.confirmed_at` is a generated
-- column (LEAST of the email and phone stamps) and must not be written.
CREATE OR REPLACE FUNCTION public.clear_email_confirmation(_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE auth.users SET email_confirmed_at = NULL WHERE id = _user_id
$$;

REVOKE EXECUTE ON FUNCTION public.clear_email_confirmation(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_email_confirmation(UUID) TO service_role;

-- Make the new objects visible to PostgREST immediately.
NOTIFY pgrst, 'reload schema';
