-- Collect an optional preferred name on the waiver.
--
-- The legal name (first/middle/last) is what the waiver needs, but plenty of
-- people go by something else on the mat: a shortened form, a middle name, or a
-- different name altogether. This stores what they want to be called so the
-- club can use it in class and in correspondence without touching the legal
-- name on the signed document.
--
-- Optional, so plain nullable TEXT on both the frozen submission and the
-- person record (manager approval copies it across like every other person
-- field). Existing rows get NULL: the club falls back to the first name.

ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS preferred_name TEXT;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferred_name TEXT;
