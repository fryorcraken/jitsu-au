-- ⛔ DO NOT APPLY THIS FILE. IT IS SUPERSEDED, AND APPLYING IT IS AN OUTAGE.
--
-- Added 2026-09-04. This file has no row in the live ledger, so
-- check-migration-drift.py would report it as unapplied and tell you to apply
-- it. It is allowlisted now, so it prints under "Allowlisted, so not counted"
-- instead -- which is a pointer to this warning, never a clearance. Do not
-- apply it.
-- Everything below went to production inside 20260822120041 instead (the third
-- body of this function), which keeps the RAISE and replaces the two Vault
-- reads with ONE: it retired `notification_digest_url` in favour of an inlined
-- https://jitsu.au/... URL, and that Vault row no longer exists.
--
-- So applying this file installs the SECOND body over the third. It would read
-- a secret that is not there, raise every night, and the club's digest would
-- stop. Verified live 2026-09-04: pg_proc.prosrc holds the third body, and
-- vault.secrets holds only `notification_digest_key`.
--
-- The file stays for the history and the reasoning, and because a from-scratch
-- replay applies it BEFORE 20260822120041 and therefore still ends on the right
-- body. It is allowlisted permanently in
-- supabase/lint/migration-drift-allowlist.txt. The sequencing note below was
-- true when written and is kept as written; it is no longer a reason to apply
-- this.
--
-- ---------------------------------------------------------------------------

-- The nightly digest job stops reporting success when it did nothing.
--
-- WHY. `private.run_notification_digest()` (20260807000000) reads two Vault
-- secrets and returns early when either is missing, with a RAISE WARNING. That
-- fail-closed posture is right and is not what this changes. What it changes is
-- what the SCHEDULER is told: a plpgsql function that RETURNs is a function that
-- succeeded, so `cron.job_run_details` records `succeeded` for every night the
-- digest has never been armed. As of this migration that is every night since
-- 20260807000000 was applied, and nothing anywhere has said so. The warning goes
-- to the Postgres log, which nobody reads on a schedule.
--
-- A green tick that means "the code ran" rather than "the work happened" is the
-- pattern this repo has been bitten by before (see the Migration drift note in
-- CLAUDE.md, which reports green while checking nothing). RAISE EXCEPTION makes
-- pg_cron record `failed` with the message, which is the truth: the job did not
-- do its job.
--
-- WHAT THIS DOES NOT FIX. pg_net is fire and forget, so an ARMED job still
-- reports success whatever the site answered (401, 503, timeout, DNS failure).
-- Reading the response back wants a second scheduled job and somewhere durable
-- to keep the verdict, since `net._http_response` is garbage-collected after
-- `pg_net.ttl` (6 hours). That is still not built. What IS now built is a check
-- on the OUTCOME rather than the mechanism: the manager notifications page
-- raises a "needs attention" item when any notification row has sat unemailed
-- for more than 36 hours, which catches every one of those failure modes plus
-- this one. See `digestStalledNotifications` in src/lib/validation.ts.
--
-- IF THE CLUB DOES NOT WANT THE DIGEST, the answer is to unschedule the job
-- (`SELECT cron.unschedule('notification-digest');`), not to leave it failing
-- nightly. A permanent red is a signal nobody reads either.
--
-- SEQUENCING. Replaces one function body. Nothing is dropped, no policy is
-- narrowed, no table or column changes, and the schedule itself is untouched.
-- The only visible effect is that an unarmed run is recorded as failed instead
-- of succeeded. Applying it cannot start emailing anybody: the fail-closed
-- branch still returns without calling out, it just raises on the way.
--
-- No `NOTIFY pgrst, 'reload schema'` at the end: `private` is not in PostgREST's
-- db-schemas, so there is nothing in this file for PostgREST to have cached.

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
  missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- `vault.decrypted_secrets`, NOT `vault.secrets`. The latter's `secret`
  -- column is the ciphertext; only the view exposes `decrypted_secret`. Reading
  -- the wrong one would send the site an Authorization header of base64 noise
  -- and get a 401 every morning.
  SELECT decrypted_secret INTO digest_url
    FROM vault.decrypted_secrets WHERE name = 'notification_digest_url';
  SELECT decrypted_secret INTO digest_key
    FROM vault.decrypted_secrets WHERE name = 'notification_digest_key';

  -- Fail closed AND fail loudly. Closed because a digest endpoint anybody can
  -- POST to is a way to make the club email its own members on demand, and loud
  -- because an unconfigured job that reports success is how a digest silently
  -- stops going out for a month.
  --
  -- Naming the secrets that are actually missing, rather than both every time,
  -- is the difference between a message somebody can act on and one they have
  -- to go and investigate. Half-configured is the likelier state of the two:
  -- the URL and the key are added by separate steps, and the key also has to
  -- match a server env var that is set somewhere else again.
  IF digest_url IS NULL THEN
    missing := missing || 'notification_digest_url';
  END IF;
  IF digest_key IS NULL THEN
    missing := missing || 'notification_digest_key';
  END IF;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'notification digest not armed: missing vault secret(s) %. No email has been sent. See docs/notifications.md.',
      array_to_string(missing, ', ');
  END IF;

  -- Fire and forget: pg_net queues the request and the response lands in
  -- `net._http_response`. The endpoint is idempotent per person per day (the
  -- digest-<user>-<date> key), so a retry after a timeout cannot double-send.
  -- The timeout is generous because the run emails every recipient inline.
  --
  -- ⚠️ Reaching this line is NOT evidence that anybody was emailed. The request
  -- id is discarded and the function returns successfully whatever the site
  -- answers. The backlog check on the notifications page is what actually
  -- watches this.
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

-- CREATE OR REPLACE keeps the existing ACL, so this re-asserts rather than
-- restores. It stays because the grant matters more than the duplication:
-- nobody but the scheduler needs to be able to make the site email everybody.
REVOKE ALL ON FUNCTION private.run_notification_digest() FROM PUBLIC;
