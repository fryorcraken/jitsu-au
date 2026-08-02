-- Move the calendar's RLS-only helpers out of the PostgREST-exposed API schema.
--
-- Supabase advisor 0028 (anon_security_definer_function_executable) flags
-- `public.event_is_invite_only(uuid)`: `anon` holds EXECUTE on it (granted in
-- 20260730114023) because the "Anyone can read public events" policy calls it,
-- and an RLS expression is evaluated as the *querying* role — without the grant
-- every anonymous calendar read fails with "permission denied for function".
--
-- The grant is real exposure, not a false positive: everything in `public` is
-- routable, so the same grant makes the function callable directly as
-- `POST /rest/v1/rpc/event_is_invite_only` with any uuid the caller likes.
-- `is_event_invitee(uuid, uuid)` is the same shape one role up — advisor 0029,
-- `authenticated` — and answers "is this person invited to this event", which is
-- a question about somebody else's RSVP row.
--
-- Neither is an app RPC. Grep `src/`: they appear only in the generated types,
-- never in a `.rpc(...)` call, because their sole job is to let the
-- `calendar_events` SELECT policies read `calendar_series` / `event_rsvps`,
-- which no client role may read directly. So the third remediation the lint
-- itself offers is the right one — move them out of the exposed API schema.
-- PostgREST only routes `/rest/v1/rpc/*` to the schemas in its `db-schemas`
-- list (`public, graphql_public`), so a function in `private` is unreachable
-- from the API while RLS can still call it.
--
-- This is not a general escape hatch for the advisor. `has_role`,
-- `has_active_paid_membership` and the `user_emails` family stay in `public`
-- precisely because the app DOES call them over PostgREST; moving those would
-- break the callers rather than the exposure. The rule this establishes is
-- narrower: a SECURITY DEFINER helper that exists ONLY to be called from inside
-- an RLS policy belongs in `private`.

-- ---------- the private schema ----------
-- No tables live here, and none should: this is for RLS helper functions only.
-- Supabase's bootstrap `ALTER DEFAULT PRIVILEGES` is scoped to schema `public`,
-- so objects created here do NOT arrive pre-granted to the client roles the way
-- a new table in `public` does — each grant below is deliberate.
--
-- USAGE on the schema is a prerequisite for EXECUTE on anything inside it and
-- conveys nothing on its own. It does not make the schema visible to PostgREST.
CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;

-- ---------- the helpers, unchanged apart from their schema ----------
-- Is this event invite-only, either directly or via its series?
CREATE OR REPLACE FUNCTION private.event_is_invite_only(_event_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.calendar_events e
    LEFT JOIN public.calendar_series s ON s.id = e.series_id
    WHERE e.id = _event_id
      AND (e.invite_only OR COALESCE(s.invite_only, false))
  )
$$;

REVOKE ALL ON FUNCTION private.event_is_invite_only(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.event_is_invite_only(uuid) TO anon, authenticated;

-- Was this user invited to the event (an RSVP row exists)?
CREATE OR REPLACE FUNCTION private.is_event_invitee(_event_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.event_rsvps r
    WHERE r.event_id = _event_id AND r.user_id = _user_id
  )
$$;

REVOKE ALL ON FUNCTION private.is_event_invitee(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.is_event_invitee(uuid, uuid) TO authenticated;

-- ---------- repoint the policies ----------
-- Identical predicates to 20260730113925; only the schema qualifier changes.
-- These have to be recreated BEFORE the old functions are dropped, because a
-- policy depends on every function it calls.
DROP POLICY IF EXISTS "Anyone can read public events" ON public.calendar_events;
CREATE POLICY "Anyone can read public events"
ON public.calendar_events
FOR SELECT
USING (
  visibility = 'public'
  AND NOT private.event_is_invite_only(id)
);

DROP POLICY IF EXISTS "Paid members can read members-only events" ON public.calendar_events;
CREATE POLICY "Paid members can read members-only events"
ON public.calendar_events
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR (
    (
      public.has_active_paid_membership(auth.uid())
      OR visibility = 'public'
    )
    AND (
      NOT private.event_is_invite_only(id)
      OR private.is_event_invitee(id, auth.uid())
    )
  )
);

-- ---------- retire the exposed copies ----------
DROP FUNCTION IF EXISTS public.event_is_invite_only(uuid);
DROP FUNCTION IF EXISTS public.is_event_invitee(uuid, uuid);
