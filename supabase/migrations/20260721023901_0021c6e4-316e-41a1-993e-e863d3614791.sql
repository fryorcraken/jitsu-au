-- Lock down SECURITY DEFINER function execution
-- handle_new_user_role: trigger only, no direct callers
REVOKE ALL ON FUNCTION public.handle_new_user_role() FROM PUBLIC, anon, authenticated;

-- has_role: used inside RLS policies evaluated as the querying role, so
-- authenticated must retain EXECUTE. Anonymous callers have no need for it.
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;