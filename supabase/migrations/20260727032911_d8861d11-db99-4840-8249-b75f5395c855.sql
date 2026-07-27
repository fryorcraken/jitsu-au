-- Manager API tokens
CREATE TABLE public.manager_api_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX manager_api_tokens_active_idx
  ON public.manager_api_tokens (token_hash)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.manager_api_tokens TO authenticated;
GRANT ALL ON public.manager_api_tokens TO service_role;

ALTER TABLE public.manager_api_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can read tokens" ON public.manager_api_tokens
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can create tokens" ON public.manager_api_tokens
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'manager') AND created_by = auth.uid());
CREATE POLICY "Managers can update tokens" ON public.manager_api_tokens
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- Calendar: paid-membership helper
CREATE OR REPLACE FUNCTION public.has_active_paid_membership(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    JOIN public.membership_plans p ON p.id = m.plan_id
    WHERE m.user_id = _user_id
      AND m.status = 'active'
      AND p.kind <> 'trial'
      AND m.price_cents > 0
  )
$$;

REVOKE EXECUTE ON FUNCTION public.has_active_paid_membership(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_paid_membership(UUID) TO authenticated, service_role;

CREATE TABLE public.calendar_series (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  instructor_name TEXT,
  location TEXT NOT NULL DEFAULT 'UTS Ultimo',
  weekday INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  duration_minutes INT NOT NULL CHECK (duration_minutes > 0),
  starts_on DATE NOT NULL,
  ends_on DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT calendar_series_dates_ok CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.calendar_series TO authenticated;
GRANT ALL ON public.calendar_series TO service_role;

ALTER TABLE public.calendar_series ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can read all series" ON public.calendar_series
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can insert series" ON public.calendar_series
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can update series" ON public.calendar_series
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can delete series" ON public.calendar_series
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'manager'));

CREATE TABLE public.calendar_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  series_id UUID REFERENCES public.calendar_series(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'session'
    CHECK (kind IN ('session', 'grading', 'seminar', 'social', 'other')),
  title TEXT NOT NULL,
  description TEXT,
  instructor_name TEXT,
  location TEXT NOT NULL DEFAULT 'UTS Ultimo',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  all_day BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'cancelled')),
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'members')),
  invite_only BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT calendar_events_time_ok CHECK (ends_at >= starts_at)
);

CREATE INDEX calendar_events_starts_at_idx ON public.calendar_events (starts_at);
CREATE INDEX calendar_events_series_id_idx ON public.calendar_events (series_id);
CREATE INDEX calendar_events_status_idx ON public.calendar_events (status);
CREATE UNIQUE INDEX calendar_events_series_occurrence_idx
  ON public.calendar_events (series_id, starts_at)
  WHERE series_id IS NOT NULL;

GRANT SELECT ON public.calendar_events TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.calendar_events TO authenticated;
GRANT ALL ON public.calendar_events TO service_role;

ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read public events" ON public.calendar_events
  FOR SELECT USING (visibility = 'public');
CREATE POLICY "Paid members can read members-only events" ON public.calendar_events
  FOR SELECT TO authenticated USING (
    public.has_active_paid_membership(auth.uid()) OR public.has_role(auth.uid(), 'manager')
  );
CREATE POLICY "Managers can insert events" ON public.calendar_events
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can update events" ON public.calendar_events
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can delete events" ON public.calendar_events
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'manager'));

CREATE TABLE public.event_rsvps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES public.calendar_events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  response TEXT NOT NULL CHECK (response IN ('going', 'maybe', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX event_rsvps_event_id_idx ON public.event_rsvps (event_id);
CREATE INDEX event_rsvps_user_id_idx ON public.event_rsvps (user_id);

GRANT SELECT ON public.event_rsvps TO authenticated;
GRANT ALL ON public.event_rsvps TO service_role;

ALTER TABLE public.event_rsvps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own RSVPs" ON public.event_rsvps
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Managers can view all RSVPs" ON public.event_rsvps
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Users can create their own RSVP" ON public.event_rsvps
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own RSVP" ON public.event_rsvps
  FOR UPDATE TO authenticated USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own RSVP" ON public.event_rsvps
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.calendar_feed_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX calendar_feed_tokens_active_idx
  ON public.calendar_feed_tokens (token_hash)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX calendar_feed_tokens_one_live_idx
  ON public.calendar_feed_tokens (user_id)
  WHERE revoked_at IS NULL;

GRANT SELECT ON public.calendar_feed_tokens TO authenticated;
GRANT ALL ON public.calendar_feed_tokens TO service_role;

ALTER TABLE public.calendar_feed_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own feed token" ON public.calendar_feed_tokens
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own feed token" ON public.calendar_feed_tokens
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can revoke their own feed token" ON public.calendar_feed_tokens
  FOR UPDATE TO authenticated USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';