-- Profiles: store each person once, keyed by email, and reduce a waiver to the
-- signed artifact that points back at that person.
--
-- Before this, every waiver row carried a full snapshot of the signer (name,
-- email, address, emergency contact, medical notes, guardian, consent) plus the
-- individual signatures. The signer's email was duplicated onto every waiver and
-- also lived on auth.users. This moves identity onto a single `profiles` row per
-- person (keyed by a unique email), and leaves `waivers` holding only the PDF,
-- provenance (template version + real signer IP), approval, timestamps, and a
-- link to the profile.
--
-- Signing stays PUBLIC (no account, no login) — the only requirement is an email.
-- The public submit path runs through the service-role client, so profiles and
-- waivers need no anon insert grant. An auth account is optional; when one is
-- created its email links it to the existing profile (see the trigger below).
--
-- There is no production data to preserve, so the waiver table is emptied and
-- reshaped in place rather than backfilled.

-- ---------- profiles (one row per person, keyed by email) ----------
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- The person's identity and the ONE email field in the system. Stored
  -- lowercased/trimmed so the unique key dedupes case variants.
  email TEXT NOT NULL UNIQUE,
  -- Optional link to a member-area auth account (set when the person signs in).
  user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Everything below is nullable: a profile can exist from just an email (a bare
  -- magic-link account) or name + email (a signup / waiver). Full name is never
  -- stored — it is composed from the parts on read.
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

-- A person reads/updates their own profile; managers read/update all. Inserts are
-- service-role only (public signing + the signup trigger both run as service role
-- / SECURITY DEFINER).
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

-- Link (or create) a person's profile when an auth account is created. If a
-- profile already exists for the email (e.g. they signed a waiver first), attach
-- the auth user id to it; otherwise create one from the signup metadata. Existing
-- non-null identity fields are preserved.
CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.profiles (email, user_id, first_name, middle_name, last_name, phone)
  VALUES (
    lower(btrim(NEW.email)),
    NEW.id,
    NULLIF(btrim(NEW.raw_user_meta_data->>'first_name'), ''),
    NULLIF(btrim(NEW.raw_user_meta_data->>'middle_name'), ''),
    NULLIF(btrim(NEW.raw_user_meta_data->>'last_name'), ''),
    NULLIF(btrim(NEW.raw_user_meta_data->>'phone'), '')
  )
  ON CONFLICT (email) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    first_name = COALESCE(public.profiles.first_name, EXCLUDED.first_name),
    middle_name = COALESCE(public.profiles.middle_name, EXCLUDED.middle_name),
    last_name = COALESCE(public.profiles.last_name, EXCLUDED.last_name),
    phone = COALESCE(public.profiles.phone, EXCLUDED.phone),
    updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_profile();

-- ---------- waivers: reduce to the signed artifact ----------
-- Drop the policies that reference the person columns / user_id before dropping
-- the columns themselves.
DROP POLICY IF EXISTS "Anyone can sign waiver" ON public.waivers;
DROP POLICY IF EXISTS "Users can view their own waivers" ON public.waivers;

-- No production data to keep. Emptying cascades to waiver_drive_uploads (FK).
TRUNCATE public.waivers CASCADE;

ALTER TABLE public.waivers
  DROP COLUMN IF EXISTS full_name,
  DROP COLUMN IF EXISTS first_name,
  DROP COLUMN IF EXISTS middle_name,
  DROP COLUMN IF EXISTS last_name,
  DROP COLUMN IF EXISTS date_of_birth,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS uts_student_number,
  DROP COLUMN IF EXISTS sms_whatsapp_consent,
  DROP COLUMN IF EXISTS emergency_contact_name,
  DROP COLUMN IF EXISTS emergency_contact_phone,
  DROP COLUMN IF EXISTS medical_notes,
  DROP COLUMN IF EXISTS acknowledgements,
  DROP COLUMN IF EXISTS signature_name,
  DROP COLUMN IF EXISTS signature_image_path,
  DROP COLUMN IF EXISTS is_minor,
  DROP COLUMN IF EXISTS guardian_name,
  DROP COLUMN IF EXISTS guardian_relationship,
  DROP COLUMN IF EXISTS guardian_signature,
  DROP COLUMN IF EXISTS guardian_signature_image_path,
  DROP COLUMN IF EXISTS user_id;

-- ip_hash was declared but never written; it now stores the signer's real IP as a
-- forensic/legal record.
ALTER TABLE public.waivers RENAME COLUMN ip_hash TO signer_ip;

-- Link every waiver to the person who signed it. The table is empty, so NOT NULL
-- is safe.
ALTER TABLE public.waivers
  ADD COLUMN profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE;
CREATE INDEX waivers_profile_id_idx ON public.waivers (profile_id);

-- Signing runs through the service role; no anon/authenticated insert path.
REVOKE INSERT ON public.waivers FROM anon, authenticated;

-- The owner sees their own waivers via their profile; managers already have a
-- read-all policy and an update (approval) policy from earlier migrations.
CREATE POLICY "Owners can view their own waivers" ON public.waivers
  FOR SELECT TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));
