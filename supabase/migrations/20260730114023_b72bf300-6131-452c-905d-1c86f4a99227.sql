GRANT EXECUTE ON FUNCTION public.event_is_invite_only(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_event_invitee(uuid, uuid) TO authenticated;