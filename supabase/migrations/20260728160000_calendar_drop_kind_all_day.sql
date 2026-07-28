-- Calendar: one kind of thing (CONTRACT phase).
--
-- Pairs with 20260728140000_calendar_one_event_model.sql (the expand phase) and
-- the code in PR #74, which stopped reading both of these columns. Per the
-- expand/contract rule in CLAUDE.md, a destructive migration lands AFTER the
-- code that stops using the old shape is deployed — never before, or the
-- currently-live code breaks in the gap.
--
-- `kind` was a fixed dropdown (session | grading | seminar | social | other)
-- that drove a cosmetic badge and nothing else: no filtering, no sorting, no
-- behaviour. With a mandatory free-text title, "Grading" already says grading,
-- and better than a taxonomy that never quite fits ("kids' intake day"?). If
-- grouping is ever genuinely wanted it should come back as a deliberate feature
-- with a use, not as a field every manager fills in on the way past.
--
-- `all_day` was never exposed by any form, in either the old two-form design or
-- the new one. A full-day grading is expressible as "9am, 8 hours", so the
-- column is dropped rather than wired up.
--
-- Both are dropped, not just abandoned, so the generated types stop advertising
-- columns nothing writes. No data is lost that the title does not already carry.

ALTER TABLE public.calendar_events
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS all_day;

-- The CHECK constraint on `kind` goes with the column automatically.

NOTIFY pgrst, 'reload schema';
