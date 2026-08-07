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
-- ⚠️ `WITH SCHEMA extensions` on pg_net is load-bearing, not tidiness.
--
-- Neither extension declares an install schema (`pg_available_extension_versions`
-- reports `schema = NULL, relocatable = false`), so without a SCHEMA clause the
-- extension lands in the first entry of `search_path`, which on this project is
-- `"$user", public, extensions` — i.e. `public`. supautils rescues pg_cron via
-- `extensions_parameter_overrides = {"pg_cron":{"schema":"pg_catalog"}}`, but it
-- has no such override for pg_net, so pg_net alone needs saying explicitly.
--
-- Landing in `public` trips the `extension_in_public` advisor, which is
-- SECURITY/WARN and not in supabase/lint/advisors-allowlist.txt, so it fails
-- supabase-lint — and once live it is a permanent Supabase dashboard finding
-- that no allowlist can clear.
--
-- CI cannot catch this: the Supabase CLI's local Postgres ships with pg_net
-- already installed, so `IF NOT EXISTS` makes it a no-op there and the lint
-- passes regardless. Only the live database, where pg_net is absent, actually
-- runs the CREATE.
--
-- This does not move `net.http_post`: pg_net's own script creates and qualifies
-- the `net` schema for its objects, so only the extension's home schema changes.
-- The assertion below is what proves that, loudly, if it is ever wrong.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

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
-- `to_regprocedure`, which takes a FULL SIGNATURE, not `to_regproc`, which takes
-- a bare name. Two distinct traps, and the signature form dodges both:
--
--   * `to_regproc` returns NULL for an OVERLOADED name as well as a missing one,
--     and pg_cron ships two `cron.schedule` overloads (2-arg and 3-arg). A
--     name-only check therefore reports a perfectly healthy pg_cron as missing.
--   * A name-only check also proves nothing about the ARGUMENTS. This project can
--     install any pg_net from 0.11.0 to 0.20.4, and the call below passes four
--     named arguments. If a version exposed different parameters, a name-only
--     check would pass, the migration would apply cleanly, and the job would
--     fail nightly with "function net.http_post(url => text, ...) does not
--     exist" — precisely the outcome this block exists to prevent.
DO $$
DECLARE
  found_in TEXT;
BEGIN
  IF to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN
    SELECT string_agg(DISTINCT n.nspname || '.' || p.proname
                      || '(' || pg_get_function_arguments(p.oid) || ')', '; ')
      INTO found_in
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'http_post';
    RAISE EXCEPTION
      'net.http_post(text,jsonb,jsonb,jsonb,integer) not found (found: %). Update private.run_notification_digest() before scheduling.',
      COALESCE(found_in, 'nothing named http_post');
  END IF;

  -- Name-only is correct here: the overload is the whole point, and the call
  -- below uses the 3-arg form which `cron.schedule` has had since 1.4.
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'pg_cron did not install cron.schedule(text,text,text); the digest cannot be scheduled.';
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
-- The unschedule is belt and braces, not a correctness requirement: pg_cron 1.4+
-- upserts `cron.schedule(name, ...)` on (jobname, username), so re-applying would
-- replace the job rather than error on a duplicate name. It stays because it
-- makes the replacement explicit. `cron.unschedule` DOES raise on a missing job,
-- hence the EXISTS guard for the from-scratch case (CI replays every migration
-- against an empty database, so that path is exercised on every PR).
--
-- The ::text cast is not optional. `cron.unschedule` is overloaded on (bigint)
-- and (text), and an uncast literal arrives as `unknown`, which is exactly the
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
