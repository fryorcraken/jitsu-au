-- Revoke the blanket client grants on the rest of the schema.
--
-- Supabase's bootstrap runs
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES
--     TO anon, authenticated, service_role;
-- so every table created in `public` starts with all eight privileges (SELECT,
-- INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) for both
-- client roles. Note MAINTAIN (Postgres 17+) does not appear in
-- information_schema.role_table_grants at all, so an audit through the
-- information_schema views under-reports by one; read pg_class.relacl instead.
--
-- GRANT only ever ADDS a privilege — no form of it replaces or narrows what a
-- role already holds. So every `GRANT SELECT ON t TO authenticated` in this
-- directory that meant "reads only" granted a privilege the role already had.
-- The line reads like a restriction in review and does nothing. Only REVOKE
-- narrows. 20260728120000_calendar_revoke_client_grants.sql fixed the four
-- calendar tables and deferred the rest; this is that pass.
--
-- Verified against the live database on 2026-07-28 via pg_class.relacl: 13
-- tables carried all eight privileges for both anon and authenticated, and
-- `waivers` carried seven (its INSERT was the one revoke that had landed). Only
-- two REVOKEs existed in the whole directory, and the second was half a fix:
-- 20260722120000 took INSERT on `memberships` from `authenticated` but not from
-- `anon`, which still holds it.
--
-- ---------------------------------------------------------------------------
-- Why this is mostly hardening, and where it is not
-- ---------------------------------------------------------------------------
-- RLS is enabled on every table and no policy is more permissive than intended,
-- so nothing was readable or writable that RLS did not already allow. There was
-- no data exposure. TRUNCATE and REFERENCES are not gated by RLS at all, but
-- neither is reachable: PostgREST never emits TRUNCATE, and these roles have no
-- direct connection.
--
-- The exception is `user_roles`, which is a live privilege-escalation path.
-- 20260720134408 grants it `SELECT TO authenticated` and nothing more, but the
-- defaults survived, and the table carries manager-scoped INSERT and DELETE
-- policies written as a backstop on the assumption that no client grant existed.
-- It does exist, so a manager can POST /rest/v1/user_roles straight from a
-- browser session and assign `manager` to any user, or delete role rows —
-- bypassing the service-role path that is the app's only role write
-- (src/lib/membership.functions.ts:163). Manager-gated, so not a public hole,
-- but a real bypass and the same shape as the calendar defect: a policy kept as
-- defence in depth goes live the moment a grant it assumed absent turns out to
-- be present.
--
-- ---------------------------------------------------------------------------
-- Why revoking everything is safe
-- ---------------------------------------------------------------------------
-- Exactly one table is queried directly by the browser client, read-only:
-- `user_roles`, in useRoles (src/hooks/useAuth.ts:41). Every file importing
-- @/integrations/supabase/client was checked for .from(), .rpc() and .storage()
-- and there is no other client-side data access. Everything else runs through
-- server functions on the service-role client, which bypasses both grants and
-- RLS, so removing the client grants takes away nothing the app uses.
--
-- The RLS policies are deliberately left in place. They cost nothing and stay
-- correct if a grant is ever added back.
--
-- Not covered here: `session_checkins`. It exists in the live database with the
-- full default grants but appears in no migration, no generated type, no doc and
-- no code in this repo, so a REVOKE naming it would fail the from-scratch replay
-- in supabase-lint.yml (relation does not exist). It needs its origin resolved
-- first; see the PR for this migration.

-- ---------- Public intake: insert-only, read via the service role ----------
REVOKE ALL ON public.interest_registrations FROM anon, authenticated;
REVOKE ALL ON public.contact_messages FROM anon, authenticated;

-- ---------- Waivers: signed through submitWaiverWithPdf on the service role ----------
REVOKE ALL ON public.waivers FROM anon, authenticated;
-- SELECT stays, and not for anything in `src/`: the storage policy "Owners can
-- read their own waiver PDF" (20260727120000_waiver_storage_policies.sql) tests
--   EXISTS (SELECT 1 FROM public.waivers w
--            WHERE w.pdf_path = objects.name AND w.user_id = auth.uid())
-- and an RLS policy expression is evaluated with the CALLER's privileges, not
-- the policy owner's. Without this grant that subquery raises `permission denied
-- for table waivers` and the owner-read path dies. The sibling manager policy
-- needs no grant because it goes through has_role(), which is SECURITY DEFINER —
-- the standard way out of this, and worth remembering before adding a table
-- reference to any policy. "Owners can view their own waivers" narrows the rows
-- to the caller's own, so the grant hands over nothing the policy would not.
GRANT SELECT ON public.waivers TO authenticated;

REVOKE ALL ON public.waiver_templates FROM anon, authenticated;
REVOKE ALL ON public.waiver_drive_uploads FROM anon, authenticated;

-- ---------- People ----------
REVOKE ALL ON public.profiles FROM anon, authenticated;

-- ---------- Membership and money ----------
REVOKE ALL ON public.membership_plans FROM anon, authenticated;
REVOKE ALL ON public.memberships FROM anon, authenticated;
REVOKE ALL ON public.bank_transactions FROM anon, authenticated;

-- ---------- Club configuration and integrations ----------
REVOKE ALL ON public.club_settings FROM anon, authenticated;
REVOKE ALL ON public.app_user_connections FROM anon, authenticated;

-- ---------- Manager agent tokens (stores token_hash) ----------
REVOKE ALL ON public.manager_api_tokens FROM anon, authenticated;

-- ---------- Roles ----------
REVOKE ALL ON public.user_roles FROM anon, authenticated;
-- The one client-facing table privilege the app actually uses: useRoles
-- (src/hooks/useAuth.ts) reads the caller's own roles from the browser to decide
-- whether to show the manager navigation. The "Users can view their own roles"
-- policy narrows it to their own rows. Role writes stay service-role only.
GRANT SELECT ON public.user_roles TO authenticated;

NOTIFY pgrst, 'reload schema';
