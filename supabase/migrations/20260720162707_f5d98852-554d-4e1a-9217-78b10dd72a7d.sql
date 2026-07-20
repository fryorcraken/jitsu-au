ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS middle_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS signature_image_path text,
  ADD COLUMN IF NOT EXISTS guardian_signature_image_path text;