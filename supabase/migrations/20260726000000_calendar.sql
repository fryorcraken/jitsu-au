-- Calendar: the club's training schedule, events, and RSVPs.
--
-- Managers define a recurring weekly SERIES (day, time, duration, instructor)
-- with a start date and an optional end date; the app materializes it into dated
-- EVENTS. One-off events (grading, seminar, social) are rows in the same table
-- with no series. Cancelling an event flips its status rather than deleting it,
-- so subscribers see the cancellation and RSVPs are preserved.
--
-- Two independent per-event flags, deliberately different in kind:
--   * visibility (public | members) — ACCESS. 'members' events are visible only
--     to paid members (and managers); the public site never shows them.
--   * invite_only (boolean)         — DISPLAY ONLY. Just badges the event as
--     "invite only"; it does not restrict who can see or RSVP to it.
--
-- Any signed-in user may RSVP (going/maybe/declined) to an event they can see —
-- trial visitors included. Managers can see who's coming. Each signed-in user can
-- mint a private ICS feed token; their feed includes members-only events only if
-- they are a paid member. There is no public feed on purpose, so a subscriber
-- never silently misses a members-only event.
--
-- Conventions match the rest of the schema: TEXT + CHECK instead of enums,
-- timestamptz, `updated_at` maintained by the app (no update triggers exist),
-- explicit GRANTs, RLS on every table, manager writes gated by
-- public.has_role(auth.uid(), 'manager').

-- ---------- paid-membership helper (used by RLS) ----------
-- "Member" for calendar purposes = an ACTIVE, PAID membership, mirroring
-- deriveLifecycleStatus() in src/lib/validation.ts (kind <> 'trial' AND
-- price_cents > 0). SECURITY DEFINER so the policy can read memberships without
-- depending on the caller's own RLS (and so a deactivated plan can't silently
-- revoke a member's access). Same shape as public.has_role.
CREATE OR REPLACE FUNCTION public.has_active_paid_membership(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
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

-- Called inside RLS policies (evaluated as the querying role), so `authenticated`
-- must keep EXECUTE; anon never needs it.
REVOKE EXECUTE ON FUNCTION public.has_active_paid_membership(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_paid_membership(UUID) TO authenticated, service_role;

-- ---------- calendar_series (recurring-session definitions) ----------
CREATE TABLE public.calendar_series (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  instructor_name TEXT,
  location TEXT NOT NULL DEFAULT 'UTS Ultimo',
  -- 0 = Sunday .. 6 = Saturday (JS getDay()); occurrences are generated weekly.
  weekday INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  duration_minutes INT NOT NULL CHECK (duration_minutes > 0),
  -- starts_on is required: the first date the weekly session runs.
  starts_on DATE NOT NULL,
  -- ends_on NULL = open-ended (recurs indefinitely; the app materializes a
  -- rolling horizon). Otherwise occurrences stop after this date.
  ends_on DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT calendar_series_dates_ok CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

GRANT SELECT ON public.calendar_series TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.calendar_series TO authenticated;
GRANT ALL ON public.calendar_series TO service_role;

ALTER TABLE public.calendar_series ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active series" ON public.calendar_series
  FOR SELECT USING (is_active = true);
CREATE POLICY "Managers can read all series" ON public.calendar_series
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can insert series" ON public.calendar_series
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can update series" ON public.calendar_series
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can delete series" ON public.calendar_series
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'manager'));

-- ---------- calendar_events (occurrences + one-off events) ----------
CREATE TABLE public.calendar_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- NULL for a standalone event; set for a materialized session occurrence.
  series_id UUID REFERENCES public.calendar_series(id) ON DELETE SET NULL,
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
  -- ACCESS: 'members' is visible only to paid members and managers.
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'members')),
  -- DISPLAY ONLY: badges the event "invite only". Enforces nothing.
  invite_only BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT calendar_events_time_ok CHECK (ends_at >= starts_at)
);

CREATE INDEX calendar_events_starts_at_idx ON public.calendar_events (starts_at);
CREATE INDEX calendar_events_series_id_idx ON public.calendar_events (series_id);
CREATE INDEX calendar_events_status_idx ON public.calendar_events (status);
-- One materialized occurrence per series per start instant (idempotent generation).
CREATE UNIQUE INDEX calendar_events_series_occurrence_idx
  ON public.calendar_events (series_id, starts_at)
  WHERE series_id IS NOT NULL;

GRANT SELECT ON public.calendar_events TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.calendar_events TO authenticated;
GRANT ALL ON public.calendar_events TO service_role;

ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;

-- Public events are readable by everyone (the marketing surface). Members-only
-- events are readable by paid members and managers. Policies are OR'd, so a paid
-- member sees both sets. Cancelled events stay readable so the cancellation shows.
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

-- ---------- event_rsvps (any signed-in user may respond) ----------
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_rsvps TO authenticated;
GRANT ALL ON public.event_rsvps TO service_role;

ALTER TABLE public.event_rsvps ENABLE ROW LEVEL SECURITY;

-- RSVP is open to ANY signed-in user (trial visitors included): a person owns
-- their own row. Managers read every RSVP so they can see who is coming.
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

-- ---------- calendar_feed_tokens (per-person private ICS subscription) ----------
-- Same pattern as manager_api_tokens: only the SHA-256 hash is stored. The token
-- rides in the feed URL path (/api/calendar/<token>) because calendar apps can't
-- send an Authorization header. The feed route reads via the service role and
-- includes members-only events only for a paid member.
CREATE TABLE public.calendar_feed_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

-- Fast lookup of a live token at feed-fetch time (the hot path).
CREATE INDEX calendar_feed_tokens_active_idx
  ON public.calendar_feed_tokens (token_hash)
  WHERE revoked_at IS NULL;
-- At most one live token per person.
CREATE UNIQUE INDEX calendar_feed_tokens_one_live_idx
  ON public.calendar_feed_tokens (user_id)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.calendar_feed_tokens TO authenticated;
GRANT ALL ON public.calendar_feed_tokens TO service_role;

ALTER TABLE public.calendar_feed_tokens ENABLE ROW LEVEL SECURITY;

-- A person may see/manage their own token row. The raw token is shown once by the
-- server function that mints it; token_hash never reaches the client.
CREATE POLICY "Users can view their own feed token" ON public.calendar_feed_tokens
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own feed token" ON public.calendar_feed_tokens
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can revoke their own feed token" ON public.calendar_feed_tokens
  FOR UPDATE TO authenticated USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Make the new objects visible to PostgREST immediately.
NOTIFY pgrst, 'reload schema';
