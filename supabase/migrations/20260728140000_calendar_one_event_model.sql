-- Calendar: one kind of thing (expand phase).
--
-- The calendar shipped with two concepts, a recurring "session" and a one-off
-- "event", and only the latter carried `visibility` and `invite_only`. A
-- recurring members-only or invite-only class was therefore impossible to
-- express: materializeSeries forced every generated date to be public. The
-- redesign collapses this to a single concept — an event, which may repeat —
-- so those settings have to live on the series too.
--
-- This is the ADDITIVE half. The matching contract migration drops
-- calendar_events.kind and calendar_events.all_day once no code reads them
-- (see docs/calendar.md and the expand/contract rule in CLAUDE.md).
--
-- Existing calendar rows are deliberately discarded. There is no production
-- calendar data worth keeping (one series, its generated dates, no RSVPs) and
-- the club asked for a clean slate rather than a shape migration.

-- ---------- clean slate ----------
-- event_rsvps cascades from calendar_events, and calendar_events cascades from
-- calendar_series, but truncate all three explicitly so the intent is on record.
TRUNCATE public.event_rsvps, public.calendar_events, public.calendar_series CASCADE;

-- ---------- a repeating event carries the same settings as a single one ----------
-- Defaults match what materializeSeries used to hardcode, so a series created
-- before this migration would be unchanged had any survived the truncate.
ALTER TABLE public.calendar_series
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'members')),
  ADD COLUMN invite_only BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.calendar_series.visibility IS
  'ACCESS, enforced: members = visible only to paid members and managers. Copied onto every generated date.';
COMMENT ON COLUMN public.calendar_series.invite_only IS
  'DISPLAY ONLY: badges the event "invite only". Enforces nothing. Copied onto every generated date.';

-- ---------- only the title is required ----------
-- Location was NOT NULL with a hardcoded 'UTS Ultimo' default, which put a venue
-- the club never chose onto every event and gave no way to say "no fixed place".
-- Instructor and description were already nullable; title stays NOT NULL on both
-- tables, and is now the only thing a manager must supply.
ALTER TABLE public.calendar_series
  ALTER COLUMN location DROP DEFAULT,
  ALTER COLUMN location DROP NOT NULL;

ALTER TABLE public.calendar_events
  ALTER COLUMN location DROP DEFAULT,
  ALTER COLUMN location DROP NOT NULL;

-- Make the new shape visible to PostgREST immediately.
NOTIFY pgrst, 'reload schema';
