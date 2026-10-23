-- Archiving: a manager marks somebody as having left the club.
--
-- A reversible bookkeeping mark, NOT a deletion and not a ban. It is meant to
-- change who the club contacts with mass email and what managers see by
-- default; every record, waiver, PDF, membership and check-in stays exactly as
-- it is, and the person can still sign in. This migration only adds the
-- columns: nothing writes them or acts on them until the code change that
-- follows it, which is where those behaviours live (a `select("*")` on
-- profiles will carry them, as NULL for everybody until then).
-- docs/erasing-personal-data.md ("Archiving is not erasure") says why this is
-- the answer that needs neither of the club's open legal questions settled.
--
--   archived_at  NULL = not archived. To be set when a manager archives the
--                person and cleared when they are restored (by hand, or, in the
--                code that follows, when they come back to train, take a
--                membership or sign a waiver).
--   archived_by  The manager who archived them. ON DELETE SET NULL like every
--                other audit column on this schema, so deleting that manager's
--                login blanks it silently (listed in erasing-personal-data.md).
--
-- The CHECK keeps the pair honest in one direction only: an archiver with no
-- archive date is meaningless, but an archive date whose archiver has since
-- been deleted is exactly what SET NULL produces, so it must stay legal.
--
-- Additive (the EXPAND half), so per docs/database-changes.md this goes live
-- BEFORE the code that reads it.
--
-- The security property this feature rests on: a member must never be able to
-- restore themselves or archive somebody else. Two locks hold it.
--
--   1. Grants. `profiles` holds no table privilege for anon or authenticated
--      (revoked in 20260728150000), and a new column starts with no column
--      privileges of its own, so neither role can write either column. The
--      owner-update RLS policy from 20260723000000 still exists, unreachable
--      only because no grant reaches it. A later grant (table-level, or
--      `GRANT UPDATE (...)` on chosen columns) would make it live, which is
--      why check-client-grants.py now reads column ACLs and PUBLIC grants as
--      well as table ones: such a grant fails supabase-lint.yml on the pull
--      request that adds it.
--   2. The trigger below, for the grant that never reaches a pull request: one
--      made by hand in the Lovable UI produces no commit, so no CI sees it. It
--      refuses any change to these two columns made for anon or authenticated,
--      whatever the grants and policies say, so the archive mark stays the
--      server's to write even on the day the first lock is opened by mistake.
--      Service-role server functions run as `service_role` and are unaffected.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS archived_by UUID;

-- Asserted separately rather than inline on ADD COLUMN, which skips the whole
-- clause, foreign key included, when the column already exists.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_archived_by_fkey;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_archived_by_fkey
    FOREIGN KEY (archived_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_archived_by_needs_archived_at;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_archived_by_needs_archived_at
    CHECK (archived_by IS NULL OR archived_at IS NOT NULL);

COMMENT ON COLUMN public.profiles.archived_at IS
  'When a manager marked this person as having left the club. NULL = not archived. Reversible; deletes nothing and blocks no sign-in. Never writable as anon or authenticated (trigger profiles_guard_archive).';

COMMENT ON COLUMN public.profiles.archived_by IS
  'The manager who archived this person. NULL when not archived, or when that manager''s login has since been deleted (ON DELETE SET NULL).';

-- "Made for anon or authenticated" is read two ways, because each alone has a
-- hole. `current_user` catches a direct write over PostgREST. Inside a SECURITY
-- DEFINER function, though, `current_user` is the function's owner, so a future
-- definer RPC a member may call would slip past it; the role in the request's
-- JWT is still the caller's there, so that is checked too. A write with no JWT
-- (a migration, the SQL console, the auth service creating a profile) carries
-- no claims and falls through to `current_user` alone.
--
-- An UPDATE that leaves both columns as they were is allowed, so a member's
-- own edit to another column of an archived row is unaffected. An INSERT has
-- nothing to compare against, so any value at all is refused.
--
-- In `public`, like `ensure_profile`, with EXECUTE revoked: a function that
-- returns `trigger` cannot be called as an RPC, firing a trigger does not check
-- EXECUTE, and `public` is the schema CI's plpgsql_check reads.
CREATE OR REPLACE FUNCTION public.guard_profile_archive()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  jwt_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
BEGIN
  IF (current_user IN ('anon', 'authenticated') OR jwt_role IN ('anon', 'authenticated'))
     AND (
       (TG_OP = 'INSERT' AND (NEW.archived_at IS NOT NULL OR NEW.archived_by IS NOT NULL))
       OR (TG_OP = 'UPDATE' AND (NEW.archived_at IS DISTINCT FROM OLD.archived_at
                                 OR NEW.archived_by IS DISTINCT FROM OLD.archived_by))
     ) THEN
    RAISE EXCEPTION 'profiles.archived_at and archived_by are written by the club''s server only'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_profile_archive() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_guard_archive ON public.profiles;
CREATE TRIGGER profiles_guard_archive
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_archive();

NOTIFY pgrst, 'reload schema';
