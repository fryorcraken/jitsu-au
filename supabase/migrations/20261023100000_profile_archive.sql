-- Archiving: a manager marks somebody as having left the club.
--
-- A reversible bookkeeping mark, NOT a deletion and not a ban. It changes who
-- the club contacts with mass email and what managers see by default; every
-- record, waiver, PDF, membership and check-in stays exactly as it is, and the
-- person can still sign in. docs/erasing-personal-data.md ("Archiving is not
-- erasure") says why this is the answer that needs neither of the club's open
-- legal questions settled.
--
--   archived_at  NULL = not archived. Set when a manager archives the person,
--                cleared when they are restored (by hand, or automatically when
--                they come back to train, take a membership or sign a waiver).
--   archived_by  The manager who archived them. ON DELETE SET NULL like every
--                other audit column on this schema, so deleting that manager's
--                login blanks it silently (listed in erasing-personal-data.md).
--
-- The CHECK keeps the pair honest in one direction only: an archiver with no
-- archive date is meaningless, but an archive date whose archiver has since
-- been deleted is exactly what SET NULL produces, so it must stay legal.
--
-- Additive (the EXPAND half), so per docs/database-changes.md this goes live
-- BEFORE the code that reads it, and nothing reads it yet.
--
-- No grant or RLS change, and that is the security property this feature rests
-- on: a member must never be able to restore themselves or archive somebody
-- else. ADD COLUMN inherits the table ACL, and `profiles` holds ZERO privileges
-- for anon and authenticated (revoked in 20260728150000), so every write goes
-- through a manager-gated service-role server function. The owner-update RLS
-- policy from 20260723000000 still exists but is unreachable without a grant.
-- A later column-level `GRANT UPDATE (...)` would make it reachable for exactly
-- the columns named, which is why check-client-grants.py now reads column ACLs
-- (pg_attribute.attacl) as well as table ones: a grant on any profiles column
-- fails supabase-lint.yml on the pull request that adds it.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_archived_by_needs_archived_at;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_archived_by_needs_archived_at
    CHECK (archived_by IS NULL OR archived_at IS NOT NULL);

COMMENT ON COLUMN public.profiles.archived_at IS
  'When a manager marked this person as having left the club. NULL = not archived. Reversible; deletes nothing. Archived people get no club-initiated mass email. Written only by service-role server functions.';

COMMENT ON COLUMN public.profiles.archived_by IS
  'The manager who archived this person. NULL when not archived, or when that manager''s login has since been deleted (ON DELETE SET NULL).';

NOTIFY pgrst, 'reload schema';
