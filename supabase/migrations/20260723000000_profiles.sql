-- Profiles + waiver submissions.
--
-- A person is identified by their email and stored once, in `profiles`. A
-- profile starts as a lightweight "visitor profile" (email, maybe name/phone,
-- no login) created when they first sign a waiver. A waiver row is a frozen
-- submission: exactly what was typed (the form fields), the signed PDF, when it
-- was signed, and the signer's real IP (legal/forensic evidence). Signatures
-- and acknowledgement ticks live only inside the PDF.
--
-- Waivers are accepted at any time, without limit — resubmission is never
-- blocked. A MANAGER'S APPROVAL is the promotion step: the app copies the
-- approved submission's details onto the profile and provisions the person's
-- login (Supabase auth user + invite email) if they don't have one. The
-- "active" waiver is the latest approved one; older approved rows are
-- superseded, unapproved ones stay pending (derived in the app, not stored).
--
-- There is no self-serve sign-up: accounts exist because a manager approved a
-- waiver. The trigger below only LINKS an existing profile to a new auth user
-- by confirmed email; it never creates profiles or grants anything.
--
-- No production data exists, so the waiver table is emptied and reshaped in
-- place rather than backfilled.

-- ---------- profiles (one row per person, keyed by email) ----------
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- The person's identity and the ONE canonical email in the system. Stored
  -- lowercased/trimmed so the unique key dedupes case variants.
  email TEXT NOT NULL UNIQUE,
  -- The person's login, once a manager's approval has provisioned it.
  user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Everything below is nullable: a visitor profile may hold just an email and
  -- a name/phone. Full details arrive when a manager approves a waiver. Full
  -- name is never stored — it is composed from the parts on read.
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
-- are service-role only (waiver submission and approval both run server-side).
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

-- Safety-net linkage: if an auth user appears whose CONFIRMED email matches an
-- unlinked profile, attach it. Approval normally does the linking itself; this
-- covers accounts that arrive another way (e.g. a manager-created login).
-- Never trust an unverified email: linking on an unconfirmed address would let
-- anyone claim another person's profile (and their PII) just by typing their
-- email — same rule as the manager-bootstrap fix in 20260721091500.
CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NOT NULL
     AND NEW.email_confirmed_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.email_confirmed_at IS NULL) THEN
    UPDATE public.profiles
      SET user_id = NEW.id, updated_at = now()
      WHERE email = lower(btrim(NEW.email)) AND user_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- The function runs only as an auth.users trigger; it must not be callable
-- through the public PostgREST RPC surface.
REVOKE EXECUTE ON FUNCTION public.handle_new_user_profile() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_profile();

-- ---------- waivers: reshape into a frozen submission ----------
-- Drop the policies that reference user_id before dropping the column.
DROP POLICY IF EXISTS "Anyone can sign waiver" ON public.waivers;
DROP POLICY IF EXISTS "Users can view their own waivers" ON public.waivers;

-- No production data to keep. Emptying cascades to waiver_drive_uploads (FK).
TRUNCATE public.waivers CASCADE;

-- The submission keeps the person fields AS SUBMITTED (frozen evidence and the
-- source that approval copies from). Derived/duplicative columns go:
--   * full_name (composed from the parts),
--   * signature columns (the signatures live inside the PDF),
--   * acknowledgements (recorded inside the PDF),
--   * user_id (linkage now goes waiver -> profile -> auth user).
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

-- Every submission attaches to the (possibly just-created) visitor profile of
-- its email. The table is empty, so NOT NULL is safe.
ALTER TABLE public.waivers
  ADD COLUMN profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE;
CREATE INDEX waivers_profile_id_idx ON public.waivers (profile_id);

-- Submissions run through the service role; no public insert path.
REVOKE INSERT ON public.waivers FROM anon, authenticated;

-- The owner sees their own waivers via their profile; managers already have a
-- read-all policy and an update (approval) policy from earlier migrations.
CREATE POLICY "Owners can view their own waivers" ON public.waivers
  FOR SELECT TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));
