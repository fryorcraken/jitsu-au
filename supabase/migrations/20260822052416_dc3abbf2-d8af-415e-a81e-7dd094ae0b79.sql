UPDATE public.notifications
   SET emailed_at = now()
 WHERE emailed_at IS NULL
   AND created_at < now() - interval '36 hours';