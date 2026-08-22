CREATE OR REPLACE FUNCTION public.notification_digest_key()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
   WHERE name = 'notification_digest_key'
   LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.notification_digest_key() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notification_digest_key() TO service_role;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$
DECLARE
  found_in TEXT;
BEGIN
  IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    SELECT string_agg(DISTINCT n.nspname || '.' || p.proname
                      || '(' || pg_get_function_arguments(p.oid) || ')', '; ')
      INTO found_in
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'gen_random_bytes';
    RAISE EXCEPTION
      'extensions.gen_random_bytes(integer) not found (found: %). pgcrypto is installed in a different schema; update this migration to reference it there.',
      COALESCE(found_in, 'nothing named gen_random_bytes');
  END IF;
END;
$$;

DO $$
BEGIN
  IF to_regclass('vault.secrets') IS NULL THEN
    RAISE NOTICE
      'vault is not installed; skipping notification_digest_key creation (no vault.secrets relation found)';
  ELSIF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_digest_key') THEN
    RAISE NOTICE 'notification_digest_key already exists in Vault; leaving it as is';
  ELSE
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'notification_digest_key'
    );
  END IF;
END;
$$;

DO $$
BEGIN
  IF to_regclass('vault.secrets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_digest_key') THEN
    RAISE EXCEPTION
      'notification_digest_key is still missing from vault.secrets after this migration ran. The digest cannot be armed until it exists.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.run_notification_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  digest_key TEXT;
BEGIN
  SELECT decrypted_secret INTO digest_key
    FROM vault.decrypted_secrets WHERE name = 'notification_digest_key';

  IF digest_key IS NULL THEN
    RAISE EXCEPTION
      'notification digest not armed: missing vault secret notification_digest_key. No email has been sent. See docs/notifications.md.';
  END IF;

  PERFORM net.http_post(
    url := 'https://jitsu.au/api/notifications/digest',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || digest_key
    ),
    timeout_milliseconds := 300000
  );
END;
$$;

REVOKE ALL ON FUNCTION private.run_notification_digest() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';