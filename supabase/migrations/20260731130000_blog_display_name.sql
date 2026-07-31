-- Optional display name, shown on blog comments (and anywhere else a person's
-- own chosen name is shown to other members/visitors, not just staff).
--
-- Defaults to nothing: when NULL, the app derives "first/preferred name + last
-- initial" (commentDisplayName in src/lib/validation.ts) rather than showing a
-- full legal name pulled from waiver/profile data on a public comment.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS display_name TEXT
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 60);

NOTIFY pgrst, 'reload schema';
