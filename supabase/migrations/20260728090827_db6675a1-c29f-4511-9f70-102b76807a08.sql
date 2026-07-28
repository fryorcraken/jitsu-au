ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS preferred_name TEXT;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferred_name TEXT;

NOTIFY pgrst, 'reload schema';