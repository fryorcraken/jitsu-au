-- Move the daily digest an hour and a half later: 20:00 UTC becomes 22:00 UTC.
--
-- WHY. `0 20 * * *` (20260807000000) lands at 6am Sydney for most of the year
-- and 7am for the rest. The first run that ever actually reached the site went
-- out at 6am on 2026-08-22, and 6am is too early for a club digest: it is
-- announcements and thread activity, not anything anybody is waiting on. The
-- club owner picked 8am/9am instead. `0 22 * * *` is 8am during AEST and 9am
-- during AEDT, so both halves of the year land somewhere a person would
-- reasonably read club email.
--
-- DST, AND WHY THIS STILL DRIFTS. pg_cron schedules are UTC and have no notion
-- of daylight saving, so this moves by an hour twice a year exactly as the old
-- schedule did. That is not fixed here and is not worth fixing: pinning a local
-- time would mean a scheduler of our own, and an hour's drift on a club digest
-- costs nothing. What the choice of 22:00 buys is that BOTH landing times are
-- sensible (8am and 9am), where 20:00's were 6am and 7am and only one of those
-- was.
--
-- SEQUENCING. Touches the schedule and nothing else. The job's name, its
-- command, and `private.run_notification_digest()` are all unchanged, so
-- nothing about what the digest does or who it emails changes — only when.
-- Applying this cannot send anything: it does not run the job, it re-registers
-- when the job runs.
--
-- The unschedule is belt and braces rather than a requirement, kept for
-- symmetry with 20260807000000: pg_cron 1.4+ upserts `cron.schedule(name, ...)`
-- on (jobname, username), so scheduling the same name again would replace the
-- entry on its own. `cron.unschedule` DOES raise on a missing job, hence the
-- EXISTS guard for the from-scratch case that CI replays on every PR.
--
-- The ::text cast is not optional. `cron.unschedule` is overloaded on (bigint)
-- and (text), and an uncast literal arrives as `unknown`, which is exactly the
-- shape that produces "function is not unique" at apply time.
SELECT cron.unschedule('notification-digest'::text)
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-digest');

SELECT cron.schedule(
  'notification-digest',
  '0 22 * * *',
  $job$SELECT private.run_notification_digest()$job$
);

-- Assert the schedule is what this file says it is. Without this the migration
-- reports success whether or not `cron.schedule` actually took, which is the
-- failure mode this whole area of the codebase has been bitten by twice.
DO $$
DECLARE
  live TEXT;
BEGIN
  SELECT schedule INTO live FROM cron.job WHERE jobname = 'notification-digest';
  IF live IS DISTINCT FROM '0 22 * * *' THEN
    RAISE EXCEPTION
      'notification-digest is scheduled as % after this migration, expected 0 22 * * *.',
      COALESCE(live, 'no such job');
  END IF;
END;
$$;
