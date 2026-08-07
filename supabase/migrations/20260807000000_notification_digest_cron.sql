-- Schedule the daily notification digest in the database, and retire the
-- GitHub Actions workflow that was doing it.
--
-- WHY THE CHANGE. The digest shipped with `.github/workflows/notification-
-- digest.yml` curling POST /api/notifications/digest on a cron schedule. That
-- was the wrong mechanism for three reasons: it put a credential that makes the
-- live site email its members into CI, on a repo that takes same-repo branches
-- from Lovable and from coding agents; it made the club's production schedule
-- depend on GitHub Actions, which delays and disables scheduled workflows on
-- quiet repos; and it put an operational concern in the repo rather than
-- alongside the data it acts on.
--
-- The original migration's header claimed pg_cron was unavailable here. That was
-- never checked — it was inferred from the extension being absent from this
-- repo's migrations, which says nothing about what the project offers.
-- `pg_available_extensions` lists pg_cron 1.6.4 and pg_net 0.20.4, so the
-- database can schedule this itself.
--
-- SEQUENCING. Additive: two extensions, one schema, one function, one scheduled
-- job. Nothing is dropped and no policy is narrowed. The job is a no-op until
-- its two Vault secrets exist (see below), so applying this cannot start
-- emailing anybody. Deleting the workflow file is a repo change and needs no
-- contract phase. See docs/database-changes.md.
--
-- ⚠️ THIS MIGRATION DOES NOT ARM THE DIGEST. Applying it schedules a job that
-- deliberately does nothing until somebody adds the two secrets in the last
-- section. That is the same fail-closed posture the endpoint itself takes when
-- NOTIFICATION_DIGEST_KEY is unset.

-- ---------- 1. Extensions ----------
-- Both create their own schema (`cron`, `net`) rather than landing in `public`.
-- Both are idempotent, so re-running is safe.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Assert the two entry points really are where the function below says they
-- are, and fail the migration if not.
--
-- This is not defensive noise. `pg_available_extension_versions` reports
-- `schema = NULL, relocatable = false` for both, meaning neither declares an
-- install schema in its control file — the schema comes from the extension's own
-- script, and Supabase has shipped pg_net into `extensions` in some versions and
-- `net` in others. Guessing wrong would not fail here: `cron.schedule` only
-- stores a command string, so a bad reference would apply cleanly and then fail
-- once a night at 20:00 UTC, in a log nobody reads. Better to find out now,
-- while somebody is watching the migration run.
-- Both checks look the name up in `pg_proc` rather than with `to_regproc`.
-- `to_regproc` returns NULL for an OVERLOADED name as well as a missing one, and
-- pg_cron ships two `cron.schedule` overloads (2-arg and 3-arg), so the obvious
-- version of this check reports a perfectly healthy pg_cron as missing.
DO $$
DECLARE
  found TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'net' AND p.proname = 'http_post'
  ) THEN
    SELECT string_agg(DISTINCT n.nspname || '.' || p.proname, ', ')
      INTO found
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'http_post';
    RAISE EXCEPTION
      'pg_net did not install net.http_post (found: %). Update private.run_notification_digest() to the real schema before scheduling.',
      COALESCE(found, 'nothing named http_post');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'cron' AND p.proname = 'schedule'
  ) THEN
    RAISE EXCEPTION 'pg_cron did not install cron.schedule; the digest cannot be scheduled.';
  END IF;
END;
$$;

-- ---------- 2. The job body ----------
-- The command pg_cron stores is world-readable to anyone who can select from
-- `cron.job`, so the bearer token must NOT appear in it. The token lives in
-- Supabase Vault (already installed here, 0.3.1) and is read at fire time by
-- this function, which is the only thing the schedule names.
--
-- `private`, not `public`: nothing calls this over PostgREST, and a function
-- that makes the site email every member has no business being an RPC. Same
-- reasoning as the RLS-only helpers documented in docs/database.md.
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.run_notification_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
-- Empty search_path with fully-qualified names throughout: a SECURITY DEFINER
-- function without this is the `function_search_path_mutable` advisor finding,
-- which fails supabase-lint at WARN. See supabase/lint/README.md.
SET search_path = ''
AS $$
DECLARE
  digest_url TEXT;
  digest_key TEXT;
BEGIN
  -- `vault.decrypted_secrets`, NOT `vault.secrets`. The latter's `secret`
  -- column is the ciphertext; only the view exposes `decrypted_secret`. Reading
  -- the wrong one would send the site an Authorization header of base64 noise
  -- and get a 401 every morning.
  SELECT decrypted_secret INTO digest_url
    FROM vault.decrypted_secrets WHERE name = 'notification_digest_url';
  SELECT decrypted_secret INTO digest_key
    FROM vault.decrypted_secrets WHERE name = 'notification_digest_key';

  -- Fail closed and say so. An unconfigured job that quietly succeeds is how a
  -- digest silently stops going out for a month.
  IF digest_url IS NULL OR digest_key IS NULL THEN
    RAISE WARNING 'notification digest not armed: missing vault secret notification_digest_url and/or notification_digest_key';
    RETURN;
  END IF;

  -- Fire and forget: pg_net queues the request and the response lands in
  -- `net._http_response`. The endpoint is idempotent per person per day (the
  -- digest-<user>-<date> key), so a retry after a timeout cannot double-send.
  -- The timeout is generous because the run emails every recipient inline.
  PERFORM net.http_post(
    url := digest_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || digest_key
    ),
    timeout_milliseconds := 300000
  );
END;
$$;

-- Nobody but the scheduler needs to be able to make the site email everybody.
REVOKE ALL ON FUNCTION private.run_notification_digest() FROM PUBLIC;

-- ---------- 3. The schedule ----------
-- 20:00 UTC is 7am Sydney during daylight saving and 6am outside it. pg_cron
-- schedules are UTC and have no notion of DST, exactly like the cron expression
-- this replaces, and an hour's drift on a club digest is not worth solving.
--
-- Unscheduled first so re-applying this migration replaces the job rather than
-- erroring on the duplicate name.
-- The ::text cast is deliberate. `cron.unschedule` is overloaded on (bigint) and
-- (text), and an unquoted literal arrives as `unknown`, which is exactly the
-- shape that produces "function is not unique" at apply time.
SELECT cron.unschedule('notification-digest'::text)
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-digest');

SELECT cron.schedule(
  'notification-digest',
  '0 20 * * *',
  $job$SELECT private.run_notification_digest()$job$
);

-- ---------- 4. Arming it (NOT done by this migration) ----------
-- Run once, by hand, when the digest should start going out. Until then the job
-- fires nightly and returns immediately with the warning above.
--
--   SELECT vault.create_secret(
--     'https://jitsu.au/api/notifications/digest', 'notification_digest_url');
--   SELECT vault.create_secret('<the same value as NOTIFICATION_DIGEST_KEY>',
--     'notification_digest_key');
--
-- The URL is the real site origin and not the published *.lovable.app host:
-- that one 302s to jitsu.au and pg_net does not follow redirects, so the job
-- would post into a redirect every morning and never reach the endpoint.
--
-- The key must match the NOTIFICATION_DIGEST_KEY server env var exactly, or the
-- endpoint answers 401. Rotating it means updating both.

NOTIFY pgrst, 'reload schema';
