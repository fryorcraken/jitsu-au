-- ---------- profiles ----------
CREATE TABLE public.profiles (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
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

REVOKE EXECUTE ON FUNCTION public.ensure_profile() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.ensure_profile();

-- ---------- service-role helpers ----------
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

-- ---------- waivers reshape ----------
DROP POLICY IF EXISTS "Anyone can sign waiver" ON public.waivers;
DROP POLICY IF EXISTS "Users can view their own waivers" ON public.waivers;

TRUNCATE public.waivers CASCADE;

ALTER TABLE public.waivers
  DROP COLUMN IF EXISTS full_name,
  DROP COLUMN IF EXISTS acknowledgements,
  DROP COLUMN IF EXISTS signature_name,
  DROP COLUMN IF EXISTS signature_image_path,
  DROP COLUMN IF EXISTS guardian_signature,
  DROP COLUMN IF EXISTS guardian_signature_image_path,
  DROP COLUMN IF EXISTS user_id;

ALTER TABLE public.waivers RENAME COLUMN ip_hash TO signer_ip;

ALTER TABLE public.waivers
  ADD COLUMN signer_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.waivers
  ALTER COLUMN first_name SET NOT NULL,
  ALTER COLUMN last_name SET NOT NULL;

ALTER TABLE public.waivers
  ADD COLUMN user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE;
CREATE INDEX waivers_user_id_idx ON public.waivers (user_id);

REVOKE INSERT ON public.waivers FROM anon, authenticated;

CREATE POLICY "Owners can view their own waivers" ON public.waivers
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';