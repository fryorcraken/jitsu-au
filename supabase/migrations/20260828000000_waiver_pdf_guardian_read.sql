-- A guardian may read their dependant's waiver PDF.
--
-- #106 gives a parent a page per child, and that page lists the child's waiver
-- history with a Download PDF button beside each one. The access model in
-- 20260727120000_waiver_storage_policies.sql says a waiver PDF is readable by
-- "the waiver's owner, or a manager", which predates dependants existing and is
-- now too narrow: a child's waiver belongs to the child, and the child has no
-- login, ever. Read literally it says the only people who may open a child's
-- waiver are a manager and the child, and the child cannot.
--
-- ⚠️ READ THIS BEFORE APPROVING: this migration is NOT what makes the download
-- button work, and issue #106 is wrong about that. It says `getWaiverPdfUrl`
-- "signs a URL only for a waiver the caller themself owns" because "the
-- `storage.objects` policy ... sub-selects `public.waivers` on `auth.uid()`".
-- The storage policy is not on that path at all. `getWaiverPdfUrl` mints its
-- signed URL with the SERVICE ROLE, which bypasses storage RLS entirely -- as
-- the header of 20260727120000 says in as many words. What actually refuses a
-- guardian is the line above it, a caller-scoped `SELECT pdf_path FROM waivers`
-- gated by the `public.waivers` policy "Owners can view their own waivers"
-- (20260723000000_profiles.sql). That is fixed in CODE in this same PR, by
-- routing the lookup through `assertActingFor` -- the household gate that every
-- other "...for this person" server function already goes through -- rather than
-- by widening `public.waivers` RLS, which would put the household rule in a
-- second place (`src/lib/household.ts` is meant to be the only one).
--
-- So what is this migration for? The same thing 20260727120000 was for. Its
-- policies exist "so the direct-from-client path is closed by construction
-- rather than by the absence of a policy, and so a future client-side read has
-- a correct, ownership-checked route". That statement of who may read a waiver
-- PDF is now out of step with the product, and a defence-in-depth rule that is
-- quietly wrong is worse than none: the next person to add a client-side read
-- inherits it as the answer. This brings it back in step. Nothing observable
-- changes when it is applied, today or after the code ships.
--
-- ---------- why a SECURITY DEFINER helper ----------
--
-- A policy expression runs as the QUERYING role, so the widened test cannot be
-- written inline. The existing owner branch gets away with sub-selecting
-- `public.waivers` because `authenticated` may already see its own waiver rows
-- through that table's own RLS -- which is exactly the reason it cannot answer
-- the guardian question: a guardian is refused those rows. Making it work
-- inline would mean granting `authenticated` wider access to `public.waivers`
-- and `public.profiles`, and `docs/database-changes.md` is explicit that the
-- answer to that is a SECURITY DEFINER helper instead, the way the manager
-- branch already does it with `public.has_role`.
--
-- It goes in `private`, not `public`, under the rule 20260802000000 set: a
-- SECURITY DEFINER helper that exists ONLY to be called from inside an RLS
-- policy belongs there, where PostgREST cannot route to it. Nothing in `src/`
-- calls this as an RPC and nothing should.
--
-- It takes no user id, deliberately. It asks about `auth.uid()` itself, so
-- unlike `has_role` it cannot be pointed at somebody else even if it were
-- reachable, and it needs no caller-scoping guard of the kind
-- 20260820000000_scope_role_helpers_to_caller.sql had to retrofit. It is also
-- not an existence oracle: it returns false both for a PDF that is not yours
-- and for one that does not exist, so a caller learns nothing either way.
--
-- Service-role callers have a NULL `auth.uid()` and never reach RLS at all, so
-- the NULL case needs no special branch here: `w.user_id = NULL` and
-- `p.guardian_user_id = NULL` are both NULL, the EXISTS is false, and the only
-- code that would ever see that false has already bypassed the policy.

-- ---------- the helper ----------
CREATE OR REPLACE FUNCTION private.waiver_pdf_readable_by_caller(_object_name TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.waivers w
    WHERE w.pdf_path = _object_name
      AND (
        -- The waiver's owner.
        w.user_id = (SELECT auth.uid())
        -- ...or the account holder that owner is a dependant of. One level
        -- only, matching `assertActingFor`: this reads the owner's OWN guardian
        -- link and never follows a chain, so a bad row building a grandchild
        -- chain grants nothing here either.
        OR EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.user_id = w.user_id
            AND p.guardian_user_id = (SELECT auth.uid())
        )
      )
  )
$$;

-- ⚠️ Postgres grants EXECUTE to PUBLIC on every newly created function and
-- there is no default-privileges safety net for it in this schema, so this
-- REVOKE is the whole guard (20260802000000 has the verified detail). Lints
-- 0028/0029 scan only the PostgREST-exposed schemas and would not catch a miss.
REVOKE ALL ON FUNCTION private.waiver_pdf_readable_by_caller(TEXT) FROM PUBLIC;
-- `authenticated` only: the policy below is `TO authenticated`, `anon` has no
-- waiver-PDF read at all, and `service_role` bypasses RLS so never calls it.
GRANT EXECUTE ON FUNCTION private.waiver_pdf_readable_by_caller(TEXT) TO authenticated;

-- ---------- the widened read policy ----------
-- Replaces "Owners can read their own waiver PDF" from 20260727120000. Renamed
-- rather than widened under the old name, because the old name would now be a
-- lie about what it permits, and a policy name is the first thing anybody reads
-- when auditing this table.
--
-- The manager branch ("Managers can read all waiver PDFs") is untouched and
-- still a separate policy: multiple PERMISSIVE policies OR together, so the
-- three readers -- owner, owner's guardian, manager -- are the union of this
-- policy and that one. The write policies from 20260727120000 are untouched
-- too. A guardian gets READ and nothing else: a signed PDF is frozen evidence,
-- and the reasoning for keeping writes manager-only applies to a parent exactly
-- as it does to a signer.
DROP POLICY IF EXISTS "Owners can read their own waiver PDF" ON storage.objects;
DROP POLICY IF EXISTS "Owners and guardians can read a waiver PDF" ON storage.objects;
CREATE POLICY "Owners and guardians can read a waiver PDF" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'waivers'
    AND private.waiver_pdf_readable_by_caller(objects.name)
  );

-- No table grants change, for anyone, so supabase/lint/client-grants-expected.txt
-- needs no edit: this adds one function grant in a schema that file does not
-- cover (it pins TABLE privileges in `public`), and takes nothing away.

NOTIFY pgrst, 'reload schema';
