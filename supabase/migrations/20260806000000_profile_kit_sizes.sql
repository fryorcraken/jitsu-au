-- Gi and belt sizes on a person's record, so a manager ordering kit or sizing
-- loan gear can see both at a glance.
--
-- Neither is a legal or identity field, so neither goes on a waiver submission
-- or the signed PDF. The `/waiver` form asks for a gi size as an optional
-- extra and writes it straight here; the club's record is the only place it
-- lives. `waiverToProfileFields` (src/lib/validation.ts) deliberately does not
-- carry these, so approving a waiver leaves them alone.
--
-- Both are size CODES off standard charts, not measurements. The two charts
-- differ: gi sizes run 000..7, belts only 0..7 (there is no 000 or 00 belt), so
-- the two CHECKs are deliberately not the same list.
--
-- ⚠️ The same two code sets live in `src/lib/kit-sizes.ts`, which feeds the Zod
-- enums and every picker. Nothing in the test suite can read a CHECK, so
-- `kit-sizes.test.ts` pins both literals: widening either array there means
-- replacing the matching constraint here.
--
-- Additive (the EXPAND half of an expand/contract change), so per
-- docs/database-changes.md this applies BEFORE the code that reads it merges.
-- No grant work: ADD COLUMN inherits the table ACL, and `profiles` holds zero
-- privileges for anon/authenticated (revoked in 20260728150000) — every read
-- and write already goes through a service-role server function.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS gi_size TEXT
    CONSTRAINT profiles_gi_size_check
    CHECK (gi_size IS NULL OR gi_size IN ('000', '00', '0', '1', '2', '3', '4', '5', '6', '7')),
  ADD COLUMN IF NOT EXISTS belt_size TEXT
    CONSTRAINT profiles_belt_size_check
    CHECK (belt_size IS NULL OR belt_size IN ('0', '1', '2', '3', '4', '5', '6', '7'));

NOTIFY pgrst, 'reload schema';
