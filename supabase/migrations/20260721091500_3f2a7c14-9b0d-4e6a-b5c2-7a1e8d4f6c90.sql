-- Harden the SECURITY DEFINER functions that gate the `manager` role.
--
-- Two issues are addressed here:
--
--   1. Privilege escalation via unverified email (HIGH).
--      `handle_new_user_role()` runs as SECURITY DEFINER and granted `manager`
--      to any auth.users row whose `email` matched a hardcoded address. Sign-up
--      is public and `auth.users.email` is user-supplied and UNVERIFIED at
--      INSERT time, so anyone who registered that address would self-escalate to
--      manager before (or without) ever proving they control the mailbox. We now
--      require the whitelisted email to be *confirmed* before provisioning the
--      role, and fire on the confirmation transition as well as INSERT (so the
--      auto-confirm configuration still bootstraps correctly).
--
--   2. Defense-in-depth for the SECURITY DEFINER functions.
--      Lock `search_path` to the empty string (all object references are fully
--      schema-qualified) so a mutable search_path cannot be used to shadow the
--      objects these elevated-privilege functions touch, and restrict EXECUTE on
--      `has_role` to `authenticated` (it is only ever called from RLS policies
--      and authenticated server functions; leaving it callable by anon/PUBLIC
--      let anyone probe whether an arbitrary user id is a manager).

-- 1. Role-check helper: empty search_path + fully qualified references.
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

REVOKE EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO authenticated;

-- 2. Manager bootstrap: only grant to a CONFIRMED whitelisted email.
CREATE OR REPLACE FUNCTION public.handle_new_user_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Never trust an unverified email. Provision `manager` only once the
  -- whitelisted address has actually been confirmed, and only on the
  -- INSERT (auto-confirm on) or the confirmation transition (confirm-email on).
  IF NEW.email = 'sensei@sydneyjitsu.com.au'
     AND NEW.email_confirmed_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.email_confirmed_at IS NULL)
  THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'manager')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- Re-point the trigger so confirmation transitions are seen, not just INSERT.
DROP TRIGGER IF EXISTS on_auth_user_created_assign_role ON auth.users;
CREATE TRIGGER on_auth_user_created_assign_role
  AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_role();
