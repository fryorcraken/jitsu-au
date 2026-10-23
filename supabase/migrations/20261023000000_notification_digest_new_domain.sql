-- Point the nightly digest at the club's new domain, utsjitsu.com.au.
--
-- WHY. The site moved from jitsu.au to utsjitsu.com.au in October 2026, and
-- jitsu.au now answers every request with a redirect to the same path on the
-- new host. `private.run_notification_digest()` POSTs to a literal
-- https://jitsu.au/... URL (20260822120041 inlined it on purpose), so since the
-- move every nightly request has gone through that redirect. pg_net (0.20.4 on
-- the live project) follows it, but libcurl does not carry an `Authorization`
-- header across to a different host. So the request arrives at the endpoint
-- with no bearer token at all, and the endpoint answers 401.
--
-- Read live on 2026-10-23, SELECT only: `net._http_response` row for the
-- 2026-10-22 22:00 UTC run had status_code 401, body {"error":"Unauthorized."},
-- and headers carrying `location: https://utsjitsu.com.au/api/notifications/
-- digest` from jitsu.au's Cloudflare edge. `cron.job_run_details` recorded that
-- run, like every run since 2026-09-01, as `succeeded`, because pg_net is fire
-- and forget. The Vault secret and this function's body had not changed since
-- 2026-08-22. The last digest that actually landed was 2026-10-08 22:00:07 UTC.
--
-- WHAT CHANGES. The URL literal, and nothing else. This is the fourth body of
-- this function: same signature, same SECURITY DEFINER and empty search_path,
-- same single Vault read, same fail-closed-and-loud unarmed branch. No
-- schedule change, no new secret, no grant change.
--
-- SEQUENCING. Safe to apply at any time. The endpoint is already live on the
-- new host (the redirect target is what answered the 401), and nothing about
-- the endpoint's code changes. The run after this is applied emails whatever
-- is owed at that moment and nothing older. On 2026-10-23 that was nothing:
-- zero rows had a NULL emailed_at.
--
-- ⚠️ If the club's primary domain changes again, this literal has to change
-- with it, in the same week. The failure is silent: the scheduler records
-- success either way. docs/notifications.md has the check.
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

  -- Fail closed AND fail loudly, exactly as 20260821000000 made this branch
  -- behave. Closed because a digest endpoint anybody can POST to is a way to
  -- make the club email its own members on demand; loud because a job that
  -- quietly returns is how a digest silently stops going out for a month.
  IF digest_key IS NULL THEN
    RAISE EXCEPTION
      'notification digest not armed: missing vault secret notification_digest_key. No email has been sent. See docs/notifications.md.';
  END IF;

  -- Fire and forget: pg_net queues the request and the response lands in
  -- `net._http_response`. The endpoint is idempotent per person per day (the
  -- digest-<user>-<date> key), so a retry after a timeout cannot double-send.
  --
  -- ⚠️ Reaching this line is NOT evidence that anybody was emailed. The
  -- request id is discarded and the function returns successfully whatever the
  -- site answers. The backlog check on the notifications page is what
  -- actually watches this.
  --
  -- The host must be the one the site is served from, never one that
  -- redirects to it: a redirect to another host drops the Authorization
  -- header, and the endpoint answers 401 to a request with no token.
  PERFORM net.http_post(
    url := 'https://utsjitsu.com.au/api/notifications/digest',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || digest_key
    ),
    timeout_milliseconds := 300000
  );
END;
$$;

-- CREATE OR REPLACE keeps the existing ACL; restated so this file is correct
-- read on its own. Nobody but the scheduler needs to be able to make the site
-- email everybody.
REVOKE ALL ON FUNCTION private.run_notification_digest() FROM PUBLIC;
