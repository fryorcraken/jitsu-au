-- Helper: is this event invite-only, either directly or via its series?
CREATE OR REPLACE FUNCTION public.event_is_invite_only(_event_id uuid)
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

REVOKE ALL ON FUNCTION public.event_is_invite_only(uuid) FROM PUBLIC, anon, authenticated;

-- Helper: was this user invited to the event (an RSVP row exists)?
CREATE OR REPLACE FUNCTION public.is_event_invitee(_event_id uuid, _user_id uuid)
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

REVOKE ALL ON FUNCTION public.is_event_invitee(uuid, uuid) FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Anyone can read public events" ON public.calendar_events;
CREATE POLICY "Anyone can read public events"
ON public.calendar_events
FOR SELECT
USING (
  visibility = 'public'
  AND NOT public.event_is_invite_only(id)
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
      NOT public.event_is_invite_only(id)
      OR public.is_event_invitee(id, auth.uid())
    )
  )
);
