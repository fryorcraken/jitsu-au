-- Previous martial arts experience, moved off the "Start your free trial"
-- lead form and onto the waiver instead, where it is useful context for
-- instructors meeting someone for the first time.
--
-- Same treatment as gi_size (20260806000000): not a legal or identity field,
-- so it is NOT part of the waiver submission or the signed PDF. The `/waiver`
-- form asks for it as an optional extra and writes it straight here.
--
-- Additive (the EXPAND half of an expand/contract change), so per
-- docs/database-changes.md this applies BEFORE the code that reads it merges.
-- No grant work: ADD COLUMN inherits the table ACL, and `profiles` holds zero
-- privileges for anon/authenticated (revoked in 20260728150000) — every read
-- and write already goes through a service-role server function.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS martial_arts_experience TEXT
    CONSTRAINT profiles_martial_arts_experience_check
    CHECK (martial_arts_experience IS NULL OR length(martial_arts_experience) <= 500);

NOTIFY pgrst, 'reload schema';
