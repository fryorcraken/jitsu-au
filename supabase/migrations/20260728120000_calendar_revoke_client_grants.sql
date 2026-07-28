-- Revoke the blanket client grants on the calendar tables.
--
-- Supabase grants ALL privileges on every table in `public` to `anon` and
-- `authenticated` by default. 20260726000000_calendar.sql wrote narrower GRANT
-- lines intending to withhold client writes, but GRANT only ever ADDS a
-- privilege — it cannot take one away — so the broad defaults survived and the
-- narrowing was a no-op. Verified against the live database: all four calendar
-- tables carried SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and
-- TRIGGER for both roles.
--
-- RLS still gated every row, so nothing was exposed across users. What leaked
-- was the ability to bypass rules that RLS cannot express and that therefore
-- live in the server functions:
--   * setRsvp refuses an RSVP to a members-only event you cannot see, to a
--     cancelled event, and to one that has already finished. A direct PostgREST
--     insert satisfied the owner-only WITH CHECK and skipped all three.
--   * revokeMyFeedToken is meant to be final. With UPDATE, a client could PATCH
--     its own revoked_at back to NULL and resurrect a calendar link it had just
--     revoked, e.g. after leaking it.
--
-- Every calendar read and write in the app goes through a server function using
-- the service-role client (calendar.functions.ts, api/calendar/$token.ts), and
-- the service role bypasses both grants and RLS, so removing the client grants
-- changes nothing the app relies on. No client code queries these tables
-- directly.
--
-- The owner-scoped RLS policies from the original migration are deliberately
-- kept: they cost nothing and stay correct if a grant is ever added back.

-- ---------- calendar_series (manager-only; the public surface is the events) ----------
REVOKE ALL ON public.calendar_series FROM anon, authenticated;

-- ---------- calendar_events (public read of the schedule, nothing more) ----------
REVOKE ALL ON public.calendar_events FROM anon, authenticated;
-- Anon reads the public schedule; the RLS policy narrows it to
-- visibility = 'public'. Authenticated additionally matches the members-only
-- policy when they hold a paid membership.
GRANT SELECT ON public.calendar_events TO anon, authenticated;

-- ---------- event_rsvps (writes only via setRsvp) ----------
REVOKE ALL ON public.event_rsvps FROM anon, authenticated;
-- A signed-in person may still read their own RSVPs directly; managers read all
-- via the existing policy. Writes are service-role only.
GRANT SELECT ON public.event_rsvps TO authenticated;

-- ---------- calendar_feed_tokens (mint/revoke only via server functions) ----------
REVOKE ALL ON public.calendar_feed_tokens FROM anon, authenticated;
-- Owner may read their own token row (the hash is not reversible and grants no
-- access on its own). Creating and revoking run through the service role.
GRANT SELECT ON public.calendar_feed_tokens TO authenticated;

-- Note: the same blanket default applies to the other tables in this schema.
-- Auditing those is deliberately out of scope here so this change stays
-- reviewable; it is worth a separate pass.

NOTIFY pgrst, 'reload schema';
