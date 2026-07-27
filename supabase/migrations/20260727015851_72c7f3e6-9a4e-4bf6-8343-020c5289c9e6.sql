ALTER TABLE public.waivers ADD COLUMN IF NOT EXISTS uts_student_number TEXT;
NOTIFY pgrst, 'reload schema';