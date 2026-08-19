-- The parent or legal guardian of a minor gets their own contact details.
--
-- Until now the form treated a minor's guardian and their emergency contact as
-- one person: `guardian_name` / `guardian_relationship` were copied from the
-- emergency contact block at submission, and there was nowhere at all to record
-- the guardian's own address, mobile or email. Those are the details the club
-- actually needs, because the guardian is the person who signs and carries the
-- liability -- and they are not always the person we would ring if something
-- happened in class (a parent at work interstate, an aunt who does the pickup).
--
-- Three additive columns per table. All nullable: they only ever hold anything
-- for a minor's submission, and every waiver signed before this one has none.
-- On the form each is optional in its own right ("leave blank if it is the same
-- as the participant's"), but what lands here is the RESOLVED value -- if the
-- guardian lives at the same address, that address is stored on the guardian
-- too, so a manager reading the record never has to go and work out which
-- blanks meant "same".
--
-- Additive (the EXPAND half of an expand/contract change), so per
-- docs/database-changes.md this applies BEFORE the code that reads it merges.
-- No grant or RLS work: ADD COLUMN inherits the table ACL, and both tables hold
-- zero privileges for anon/authenticated (revoked in 20260728150000) -- every
-- read and write goes through a service-role server function.

-- The frozen submission: the guardian's details exactly as given when signing.
ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS guardian_address TEXT;

ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS guardian_phone TEXT;

ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS guardian_email TEXT;

COMMENT ON COLUMN public.waivers.guardian_address IS
  'The signing parent/guardian''s address, as submitted. Resolved: equals the participant''s address when the signer left it blank as "same as the participant''s". NULL for an adult submission.';

COMMENT ON COLUMN public.waivers.guardian_phone IS
  'The signing parent/guardian''s mobile, as submitted. Resolved the same way as guardian_address. NULL for an adult submission.';

COMMENT ON COLUMN public.waivers.guardian_email IS
  'The signing parent/guardian''s email, as submitted. Resolved the same way as guardian_address. Evidence only -- the person record is still keyed on the participant''s email (docs/waivers.md rule 1). NULL for an adult submission.';

-- The live record: waiver approval copies the approved submission across, the
-- same way it already copies guardian_name and guardian_relationship.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS guardian_address TEXT;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS guardian_phone TEXT;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS guardian_email TEXT;

COMMENT ON COLUMN public.profiles.guardian_email IS
  'The guardian''s email for a minor member, promoted from their approved waiver. Not a login: the only email anyone signs in with lives on auth.users, and it is the participant''s.';

NOTIFY pgrst, 'reload schema';
