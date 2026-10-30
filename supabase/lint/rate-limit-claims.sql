-- What `public.claim_rate_limit` promises, checked against the replayed schema
-- by supabase-lint.yml (#52). Every statement runs inside one transaction that
-- is rolled back, so it leaves nothing behind and can be pointed at any
-- database built from the migrations. A broken promise raises, and psql's
-- ON_ERROR_STOP turns that into a failed step.
--
-- The unit suite cannot see this: the counting, the retry rule and the wait
-- all live in SQL, and the app's tests only see what the function returns.

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Three slots an hour on one network: three different submissions fit.
  FOR i IN 1..3 LOOP
    SELECT * INTO r FROM public.claim_rate_limit('test:form', 'net-a', 'sub-' || i, 3, NULL);
    IF NOT r.allowed THEN RAISE EXCEPTION 'submission % of 3 was refused', i; END IF;
  END LOOP;

  -- The fourth is refused, with the hour to wait.
  SELECT * INTO r FROM public.claim_rate_limit('test:form', 'net-a', 'sub-4', 3, NULL);
  IF r.allowed THEN RAISE EXCEPTION 'a fourth submission got past a limit of three'; END IF;
  IF r.retry_after_seconds NOT BETWEEN 3590 AND 3600 THEN
    RAISE EXCEPTION 'expected about an hour to wait, got % seconds', r.retry_after_seconds;
  END IF;

  -- A retry of a submission already counted is let through without counting,
  -- even at the limit: that is useResilientSubmit resending one form fill.
  SELECT * INTO r FROM public.claim_rate_limit('test:form', 'net-a', 'sub-2', 3, NULL);
  IF NOT r.allowed THEN RAISE EXCEPTION 'a retry of a counted submission was refused'; END IF;

  -- ...and from another network too (the phone moved to mobile data).
  SELECT * INTO r FROM public.claim_rate_limit('test:form', 'net-b', 'sub-2', 3, NULL);
  IF NOT r.allowed THEN RAISE EXCEPTION 'a retry from a second network was refused'; END IF;
  IF (SELECT count(*) FROM public.rate_limit_hits WHERE bucket = 'test:form') <> 3 THEN
    RAISE EXCEPTION 'retries were counted as submissions';
  END IF;

  -- A refusal records nothing, so trying again while refused does not push
  -- the wait further out.
  SELECT * INTO r FROM public.claim_rate_limit('test:form', 'net-a', 'sub-5', 3, NULL);
  IF (SELECT count(*) FROM public.rate_limit_hits WHERE bucket = 'test:form') <> 3 THEN
    RAISE EXCEPTION 'a refused claim was recorded';
  END IF;

  -- The wait is until the hit holding the limit ages out of the window.
  UPDATE public.rate_limit_hits SET created_at = now() - INTERVAL '50 minutes'
    WHERE bucket = 'test:form' AND dedupe_key = 'sub-1';
  SELECT * INTO r FROM public.claim_rate_limit('test:form', 'net-a', 'sub-6', 3, NULL);
  IF r.retry_after_seconds NOT BETWEEN 590 AND 600 THEN
    RAISE EXCEPTION 'expected about ten minutes to wait, got % seconds', r.retry_after_seconds;
  END IF;

  -- Another network has its own counter.
  SELECT * INTO r FROM public.claim_rate_limit('test:form', 'net-b', 'sub-7', 3, NULL);
  IF NOT r.allowed THEN RAISE EXCEPTION 'one network''s limit refused another'; END IF;

  -- A daily limit counts the whole day, not just the hour.
  UPDATE public.rate_limit_hits SET created_at = now() - INTERVAL '5 hours'
    WHERE bucket = 'test:form' AND subject = 'net-a';
  SELECT * INTO r FROM public.claim_rate_limit('test:form', 'net-a', 'sub-8', 3, 3);
  IF r.allowed THEN RAISE EXCEPTION 'the daily limit let a fourth through'; END IF;
  IF r.retry_after_seconds NOT BETWEEN 68390 AND 68400 THEN
    RAISE EXCEPTION 'expected about 19 hours to wait, got % seconds', r.retry_after_seconds;
  END IF;

  -- With no dedupe key every claim counts (the club-wide email caps).
  SELECT * INTO r FROM public.claim_rate_limit('test:email', 'club', NULL, NULL, 2);
  SELECT * INTO r FROM public.claim_rate_limit('test:email', 'club', NULL, NULL, 2);
  SELECT * INTO r FROM public.claim_rate_limit('test:email', 'club', NULL, NULL, 2);
  IF r.allowed THEN RAISE EXCEPTION 'a third keyless claim got past a limit of two'; END IF;

  -- Nothing older than a day is kept.
  UPDATE public.rate_limit_hits SET created_at = now() - INTERVAL '25 hours'
    WHERE bucket = 'test:email';
  SELECT * INTO r FROM public.claim_rate_limit('test:email', 'club', NULL, NULL, 2);
  IF NOT r.allowed THEN RAISE EXCEPTION 'day-old hits still counted'; END IF;
  IF (SELECT count(*) FROM public.rate_limit_hits WHERE bucket = 'test:email') <> 1 THEN
    RAISE EXCEPTION 'day-old hits were not deleted';
  END IF;

  -- A slot given back is free again, and only that key's slot goes.
  SELECT * INTO r FROM public.claim_rate_limit('test:release', 'addr', 'mail-1', NULL, 2);
  SELECT * INTO r FROM public.claim_rate_limit('test:release', 'addr', 'mail-2', NULL, 2);
  SELECT * INTO r FROM public.claim_rate_limit('test:release', 'addr', 'mail-3', NULL, 2);
  IF r.allowed THEN RAISE EXCEPTION 'a third email got past a cap of two'; END IF;
  PERFORM public.release_rate_limit('test:release', 'mail-1');
  IF (SELECT count(*) FROM public.rate_limit_hits WHERE bucket = 'test:release') <> 1 THEN
    RAISE EXCEPTION 'release did not remove exactly the one slot';
  END IF;
  SELECT * INTO r FROM public.claim_rate_limit('test:release', 'addr', 'mail-3', NULL, 2);
  IF NOT r.allowed THEN RAISE EXCEPTION 'a released slot was not free again'; END IF;
  PERFORM public.release_rate_limit('test:release', 'never-claimed');

  -- Nobody but the server can call it or read what it keeps.
  IF has_function_privilege('anon', 'public.claim_rate_limit(text, text, text, integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_rate_limit(text, text, text, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a client role can call claim_rate_limit';
  END IF;
  IF has_function_privilege('anon', 'public.release_rate_limit(text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.release_rate_limit(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a client role can call release_rate_limit';
  END IF;
END
$$;

ROLLBACK;
