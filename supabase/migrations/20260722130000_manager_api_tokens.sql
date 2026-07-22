-- Manager API tokens: manager-issued bearer credentials for the manager agent
-- API (/api/manager/agent). Replaces the single static MANAGER_AGENT_API_KEY
-- env secret with revocable, per-purpose tokens a manager mints from the UI.
--
-- Only a SHA-256 hash of each token is stored; the raw token is shown once at
-- creation and never again. `token_prefix` keeps a short, non-secret label
-- (e.g. "utsj_1a2b3c4d") so a manager can tell tokens apart in the list.
CREATE TABLE public.manager_api_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

-- Fast lookup of live tokens at authentication time (the hot path).
CREATE INDEX manager_api_tokens_active_idx
  ON public.manager_api_tokens (token_hash)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.manager_api_tokens TO authenticated;
GRANT ALL ON public.manager_api_tokens TO service_role;

ALTER TABLE public.manager_api_tokens ENABLE ROW LEVEL SECURITY;

-- Manager-only. Creation and authentication go through service-role server
-- functions (which never expose token_hash to the client); these policies keep
-- non-managers out of any direct client access.
CREATE POLICY "Managers can read tokens" ON public.manager_api_tokens
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can create tokens" ON public.manager_api_tokens
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'manager') AND created_by = auth.uid());
-- Revoking is an UPDATE (revoked_at); managers may update any token.
CREATE POLICY "Managers can update tokens" ON public.manager_api_tokens
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));
