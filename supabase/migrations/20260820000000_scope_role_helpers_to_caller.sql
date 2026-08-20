-- Stop `has_role` and `has_active_paid_membership` answering about other people.
--
-- Both are SECURITY DEFINER and both hold `EXECUTE` for `authenticated`, because
-- RLS policies call them and a policy runs as the querying role. But a function
-- `authenticated` may execute is also reachable as `POST /rest/v1/rpc/<name>`
-- with the anon key and any session — and neither one restricted `_user_id`.
-- So any signed-in person could ask, about ANY uuid: is this account a manager?
-- is it a paying member?
--
-- Uuids are not hard to come by. `blog_comments` exposes `user_id` under its
-- public SELECT grant next to the commenter's name, and `calendar_events`
-- exposes `created_by`. That turns a general oracle into a targeted one: pick a
-- named person off the blog, learn their club status. This repo already closed
-- exactly this shape once — `20260802000000_private_rls_helpers.sql` moved
-- `event_is_invite_only`, `is_event_invitee` and `is_commenter_blocked` into the
-- non-exposed `private` schema, citing advisors 0028/0029 and the same
-- "callable with any uuid the caller likes" reasoning. These two were left in
-- `public` because server code calls them as RPCs, so they need the other fix:
-- keep them callable, and make them refuse the question.
--
-- The rule: answer only about yourself, unless there is no `auth.uid()` at all.
--
--   * RLS policies always pass `auth.uid()`, so they are unaffected.
--   * Server functions using the caller-scoped client (`requireSupabaseAuth`)
--     pass `context.userId`, which IS `auth.uid()`.
--   * Service-role callers have no `auth.uid()` (it is NULL) and must keep
--     asking about anybody — the notification digest, the manager agent API
--     checking a token owner, and the calendar feed all do exactly that.
--   * `anon` cannot reach either function; EXECUTE was revoked from PUBLIC and
--     anon when each was created, and stays revoked here.
--
-- The browser never calls either one: `useRoles` reads its own `user_roles` rows
-- through RLS instead, so nothing client-side changes.
--
-- Both keep returning FALSE rather than NULL or an error when the answer is
-- refused. `SELECT EXISTS(...)` never returning NULL is a documented contract
-- these functions rely on (see the RPC-nullability note in CLAUDE.md and
-- `src/lib/supabase-rpc.ts`), and a refusal that raised would turn a probe into
-- a different, equally readable signal.
--
-- Body logic is otherwise untouched, and no grant changes, so
-- `supabase/lint/client-grants-expected.txt` needs no edit.

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (
      -- NULL means service role (anon holds no EXECUTE), which asks about others
      -- legitimately. A real session may only ask about itself.
      (SELECT auth.uid()) IS NULL
      OR _user_id = (SELECT auth.uid())
    )
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id AND role = _role
    )
$$;

CREATE OR REPLACE FUNCTION public.has_active_paid_membership(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (
      (SELECT auth.uid()) IS NULL
      OR _user_id = (SELECT auth.uid())
    )
    AND EXISTS (
      SELECT 1
      FROM public.memberships m
      JOIN public.membership_plans p ON p.id = m.plan_id
      WHERE m.user_id = _user_id
        AND m.status = 'active'
        AND p.kind <> 'trial'
        AND m.price_cents > 0
    )
$$;

-- Re-assert the grants the bodies rely on. `CREATE OR REPLACE` keeps the
-- existing ACL, so these are belt-and-braces rather than a change: they restate
-- the intent next to the code it protects, and make a from-scratch replay land
-- in the same place as the live database.
REVOKE EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.has_active_paid_membership(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_paid_membership(UUID) TO authenticated, service_role;
