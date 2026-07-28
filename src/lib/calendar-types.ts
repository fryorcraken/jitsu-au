// Row/client type aliases for the calendar tables.
//
// These were hand-written while the calendar migration was newer than the last
// Lovable types regen. The types have since been regenerated and now carry
// calendar_series, calendar_events, event_rsvps, calendar_feed_tokens, the
// has_active_paid_membership RPC and user_emails — everything the calendar
// touches — so the aliases point straight at the generated definitions. Keeping
// a second hand-written copy would silently go stale the next time a column
// changes, and intersecting one with the generated table produced conflicting
// row types.
//
// Note this deliberately builds on the plain generated `Database`, not on
// `AppDatabase`: that one overrides `waivers` with columns the generated types
// still lack, which makes it incompatible with the client the auth middleware
// hands to a server function.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Tables = Database["public"]["Tables"];

export type CalendarSeriesRow = Tables["calendar_series"]["Row"];
export type CalendarEventRow = Tables["calendar_events"]["Row"];
export type EventRsvpRow = Tables["event_rsvps"]["Row"];
export type CalendarFeedTokenRow = Tables["calendar_feed_tokens"]["Row"];

/**
 * The columns the calendar reads for display. Selecting a subset narrows the
 * row type, so projections take this rather than the full row.
 */
export type CalendarEventSelection = Pick<
  CalendarEventRow,
  | "id"
  | "series_id"
  | "title"
  | "description"
  | "instructor_name"
  | "location"
  | "starts_at"
  | "ends_at"
  | "status"
  | "visibility"
  | "invite_only"
>;

/** The feed additionally needs updated_at, which drives the ICS SEQUENCE. */
export type CalendarFeedSelection = CalendarEventSelection & Pick<CalendarEventRow, "updated_at">;

/**
 * The detail columns a series and its generated dates BOTH carry, so one patch
 * can update either. Derived from the generated Update shapes rather than
 * hand-written, so a column change is a type error here first.
 */
export type EntryDetailsPatch = Pick<
  Tables["calendar_series"]["Update"] & Tables["calendar_events"]["Update"],
  "title" | "description" | "instructor_name" | "location" | "visibility" | "invite_only"
>;

export type CalendarClient = SupabaseClient<Database>;
