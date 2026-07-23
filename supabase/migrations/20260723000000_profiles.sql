-- Profiles + waiver submissions, with auth.users.email as the ONLY email.
--
-- A person = an auth user (their email lives there, once) + a `profiles` row
-- keyed by that user id holding the person fields. There is no email column
-- anywhere in public: one-profile-per-person is enforced by auth's unique
-- email. A "visitor" (someone who has provided an email, e.g. by signing the
-- waiver) is a LOCKED auth user: created server-side with a long ban and no
-- credentials, so they cannot log in. A manager approving a waiver copies the
-- submission's details onto the profile, lifts the ban, and sends a sign-in
-- email — that is the moment a visitor becomes a member with a login.
--
-- A waiver row is a frozen submission: exactly what was typed (including the
-- email as submitted — evidence, not a live record), the signed PDF, when it
-- was signed, the signer's real IP and signing context. Signatures and
-- acknowledgement ticks live only inside the PDF. Waivers are accepted at any
-- time, without limit; the "active" waiver is the latest approved one (derived
-- in the app, not stored).
--
-- There is no self-serve sign-up. No production data exists, so the waiver
-- table is emptied and reshaped in place rather than backfilled.

-- ---------- profiles (person fields for an auth user) ----------
CREATE TABLE public.profiles (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- All person fields are nullable: a visitor profile may hold just a name and
  -- phone (the email lives on auth.users). Full details arrive when a manager
  -- approves a waiver. Full name is never stored — composed from the parts.
  first_name TEXT,
  middle_name TEXT,
  last_name TEXT,
  date_of_birth DATE,
  address TEXT,
  phone TEXT,
  uts_student_number TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  medical_notes TEXT,
  is_minor BOOLEAN NOT NULL DEFAULT false,
  guardian_name TEXT,
  guardian_relationship TEXT,
  sms_whatsapp_consent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- A person reads/updates their own profile; managers read/update all. Inserts
-- are service-role only (waiver submission and the ensure_profile trigger).
CREATE POLICY "Users can view their own profile" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Managers can view all profiles" ON public.profiles
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Users can update their own profile" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Managers can update profiles" ON public.profiles
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- Every auth user gets a profile row, no matter how the user was created
-- (waiver submission, dashboard, invite). Pure id attachment — no email
-- matching, so nothing can ever be claimed by typing someone else's address.
CREATE OR REPLACE FUNCTION public.ensure_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Trigger-only function: not callable through the public PostgREST RPC surface.
REVOKE EXECUTE ON FUNCTION public.ensure_profile() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.ensure_profile();

-- ---------- service-role helpers over auth.users (the one email store) ----------
-- Both are SECURITY DEFINER lookups into auth.users, callable ONLY by the
-- service role (EXECUTE revoked from everything else): the server resolves a
-- person by email at waiver submission, and batch-resolves emails for manager
-- screens and transactional emails.

CREATE OR REPLACE FUNCTION public.user_id_by_email(_email TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM auth.users
  WHERE lower(email) = lower(btrim(_email))
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.user_emails(_user_ids UUID[])
RETURNS TABLE (user_id UUID, email TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, email::text FROM auth.users WHERE id = ANY(_user_ids)
$$;

REVOKE EXECUTE ON FUNCTION public.user_id_by_email(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.user_emails(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_id_by_email(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.user_emails(UUID[]) TO service_role;

-- ---------- waivers: reshape into a frozen submission ----------
-- Drop the policies that reference the old user_id column before dropping it.
DROP POLICY IF EXISTS "Anyone can sign waiver" ON public.waivers;
DROP POLICY IF EXISTS "Users can view their own waivers" ON public.waivers;

-- No production data to keep. Emptying cascades to waiver_drive_uploads (FK).
TRUNCATE public.waivers CASCADE;

-- The submission keeps the person fields AS SUBMITTED (frozen evidence and the
-- source that approval copies from). Derived/duplicative columns go:
--   * full_name (composed from the parts),
--   * signature columns (the signatures live inside the PDF),
--   * acknowledgements (recorded inside the PDF),
--   * the old nullable auth user_id (re-added below, NOT NULL, via profiles).
ALTER TABLE public.waivers
  DROP COLUMN IF EXISTS full_name,
  DROP COLUMN IF EXISTS acknowledgements,
  DROP COLUMN IF EXISTS signature_name,
  DROP COLUMN IF EXISTS signature_image_path,
  DROP COLUMN IF EXISTS guardian_signature,
  DROP COLUMN IF EXISTS guardian_signature_image_path,
  DROP COLUMN IF EXISTS user_id;

-- ip_hash was declared but never written; it now stores the signer's real IP as
-- a forensic/legal record.
ALTER TABLE public.waivers RENAME COLUMN ip_hash TO signer_ip;

-- More signing-context evidence for liability: request headers captured
-- server-side (user agent, language, client hints) plus a small self-reported
-- block from the browser (timezone, screen, platform). Kept as one JSONB blob
-- on the frozen submission; never copied to the profile.
ALTER TABLE public.waivers
  ADD COLUMN signer_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The split name parts are what submissions actually provide (full_name is
-- gone); require the required ones. The table is empty, so this is safe.
ALTER TABLE public.waivers
  ALTER COLUMN first_name SET NOT NULL,
  ALTER COLUMN last_name SET NOT NULL;

-- Every submission belongs to a person (the possibly-locked auth user created
-- at submission time). The table is empty, so NOT NULL is safe.
ALTER TABLE public.waivers
  ADD COLUMN user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE;
CREATE INDEX waivers_user_id_idx ON public.waivers (user_id);

-- Submissions run through the service role; no public insert path.
REVOKE INSERT ON public.waivers FROM anon, authenticated;

-- The owner sees their own waivers; managers already have a read-all policy
-- and an update (approval) policy from earlier migrations.
CREATE POLICY "Owners can view their own waivers" ON public.waivers
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
