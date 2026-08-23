SELECT cron.unschedule('notification-digest'::text)
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-digest');

SELECT cron.schedule(
  'notification-digest',
  '0 22 * * *',
  $job$SELECT private.run_notification_digest()$job$
);

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