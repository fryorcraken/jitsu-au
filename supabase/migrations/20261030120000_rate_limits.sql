-- Rate limits on the public forms, and caps on the email they cause (#52).
--
-- The interest form, the contact form, the waiver and the code of conduct all
-- accept writes from somebody who is not signed in, and until this nothing
-- bounded how often. Each accepted waiver creates an auth user and a PDF; each
-- interest or contact submission emails whatever address was typed in, plus
-- every manager. A bot could make the club email strangers by the thousand,
-- and the damage that does to the sending domain's reputation lands on the
-- sign-in and activation emails too.
--
-- One table of hits, one function that claims a slot. The app decides what is
-- counted and what the limits are (src/lib/rate-limit.ts); this only counts.
--
--   bucket      what is being limited: `form:interest`, `email:recipient`, ...
--   subject     who it is limited per: a network, a hashed address, `club`
--   dedupe_key  the client_submission_id (or email idempotency key) that
--               claimed this slot. The same key claiming again is let through
--               WITHOUT counting, so useResilientSubmit's automatic retries of
--               one form fill are one submission, not several.
--
-- Rows are deleted once they are a day old, which is the longest window there
-- is, so the table only ever holds the last day. That is also all the club
-- keeps of which network submitted what.
--
-- Service role only. Nothing in the browser reads or writes this, and the
-- public intake clients (`anon`) never call the function: the server lazy-loads
-- the service-role client for it, as it already does for the emails.

CREATE TABLE public.rate_limit_hits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket TEXT NOT NULL CHECK (char_length(bucket) BETWEEN 1 AND 100),
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  dedupe_key TEXT CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rate_limit_hits_counter_idx
  ON public.rate_limit_hits (bucket, subject, created_at);

-- One slot per submission per bucket, whichever network it arrived from: a
-- phone that drops off the wifi and retries on mobile data is still one.
CREATE UNIQUE INDEX rate_limit_hits_dedupe_idx
  ON public.rate_limit_hits (bucket, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX rate_limit_hits_created_at_idx
  ON public.rate_limit_hits (created_at);

ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_hits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rate_limit_hits TO service_role;

-- Claim one slot in a counter, or say how long until one frees up.
--
-- `_hour_max` / `_day_max` are the most hits allowed in the last rolling hour
-- and day; NULL (or left out) means no limit over that window. The optional
-- arguments carry DEFAULT NULL so the generated types print them as optional
-- rather than as a non-null value a caller would have to cast around. A refused claim records
-- nothing, so somebody who keeps trying while refused is not pushing their own
-- wait further out, and the window frees on its own.
--
-- `retry_after_seconds` is how long until the hit holding the limit ages out,
-- which is what the person is told to wait. 0 when allowed.
--
-- The advisory lock serialises claims on one counter, so two requests landing
-- together cannot both take the last slot. It is transaction-scoped and the
-- function runs in the RPC's own transaction, so it cannot leak.
CREATE OR REPLACE FUNCTION public.claim_rate_limit(
  _bucket TEXT,
  _subject TEXT,
  _dedupe_key TEXT DEFAULT NULL,
  _hour_max INTEGER DEFAULT NULL,
  _day_max INTEGER DEFAULT NULL
)
RETURNS TABLE (allowed BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  _now TIMESTAMPTZ := now();
  _hour_count INTEGER;
  _day_count INTEGER;
  _edge TIMESTAMPTZ;
  _wait INTERVAL := INTERVAL '0';
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(_bucket || E'\n' || _subject, 0)
  );

  -- Forget anything past the longest window. Cheap at this table's size, and
  -- it keeps the "one day and no more" promise above without a scheduler.
  DELETE FROM public.rate_limit_hits h WHERE h.created_at < _now - INTERVAL '1 day';

  IF _dedupe_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.rate_limit_hits h
    WHERE h.bucket = _bucket AND h.dedupe_key = _dedupe_key
  ) THEN
    RETURN QUERY SELECT true, 0;
    RETURN;
  END IF;

  SELECT
    count(*) FILTER (WHERE h.created_at > _now - INTERVAL '1 hour'),
    count(*)
  INTO _hour_count, _day_count
  FROM public.rate_limit_hits h
  WHERE h.bucket = _bucket AND h.subject = _subject
    AND h.created_at > _now - INTERVAL '1 day';

  -- With N hits in the window and room for M, one more fits once the M-th
  -- newest has aged out of it.
  IF _hour_max IS NOT NULL AND _hour_count >= _hour_max THEN
    SELECT h.created_at INTO _edge
    FROM public.rate_limit_hits h
    WHERE h.bucket = _bucket AND h.subject = _subject
      AND h.created_at > _now - INTERVAL '1 hour'
    ORDER BY h.created_at DESC
    OFFSET GREATEST(_hour_max - 1, 0) LIMIT 1;
    _wait := GREATEST(_wait, COALESCE(_edge + INTERVAL '1 hour' - _now, INTERVAL '1 hour'));
  END IF;

  IF _day_max IS NOT NULL AND _day_count >= _day_max THEN
    SELECT h.created_at INTO _edge
    FROM public.rate_limit_hits h
    WHERE h.bucket = _bucket AND h.subject = _subject
      AND h.created_at > _now - INTERVAL '1 day'
    ORDER BY h.created_at DESC
    OFFSET GREATEST(_day_max - 1, 0) LIMIT 1;
    _wait := GREATEST(_wait, COALESCE(_edge + INTERVAL '1 day' - _now, INTERVAL '1 day'));
  END IF;

  IF _wait > INTERVAL '0' THEN
    RETURN QUERY SELECT false, GREATEST(1, ceil(extract(epoch FROM _wait))::INTEGER);
    RETURN;
  END IF;

  -- ON CONFLICT: the same submission racing in from a second network, which
  -- the advisory lock (keyed per network) does not serialise. Either way it is
  -- one slot.
  INSERT INTO public.rate_limit_hits (bucket, subject, dedupe_key)
  VALUES (_bucket, _subject, _dedupe_key)
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT true, 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_rate_limit(TEXT, TEXT, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_rate_limit(TEXT, TEXT, TEXT, INTEGER, INTEGER)
  TO service_role;

-- Give back a slot that was claimed but not used.
--
-- An email is counted against two or three caps (the address, the network,
-- the club) and then sent. If a later cap refuses it, or the send fails, the
-- earlier claims would otherwise stand, and an address could lose its whole
-- day's allowance to emails that never went. Removes the one row this key
-- claimed in this bucket, nothing else; a key that claimed nothing is a no-op.
CREATE OR REPLACE FUNCTION public.release_rate_limit(_bucket TEXT, _dedupe_key TEXT)
RETURNS VOID
LANGUAGE sql
SET search_path = ''
AS $$
  DELETE FROM public.rate_limit_hits h
  WHERE h.bucket = _bucket AND h.dedupe_key = _dedupe_key;
$$;

REVOKE ALL ON FUNCTION public.release_rate_limit(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_rate_limit(TEXT, TEXT) TO service_role;
