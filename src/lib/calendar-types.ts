// Row/client type aliases for the calendar tables.
//
// The calendar migration (20260726000000_calendar.sql) is newer than the last
// Lovable types regen, so this module hand-writes the current rows and layers
// them onto the app Database (which already adds profiles/waivers). Once Lovable
// regenerates the generated types, these aliases can collapse into them.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppDatabase } from "@/lib/profile-types";

export type CalendarSeriesRow = {
  id: string;
  title: string;
  description: string | null;
  instructor_name: string | null;
  location: string;
  weekday: number;
  start_time: string;
  duration_minutes: number;
  starts_on: string;
  /** NULL = open-ended (recurs indefinitely). */
  ends_on: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CalendarEventRow = {
  id: string;
  series_id: string | null;
  kind: string;
  title: string;
  description: string | null;
  instructor_name: string | null;
  location: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  status: string;
  /** ACCESS: 'public' | 'members' (members = paid members only). */
  visibility: string;
  /** DISPLAY ONLY: badges the event "invite only"; enforces nothing. */
  invite_only: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type EventRsvpRow = {
  id: string;
  event_id: string;
  user_id: string;
  response: string;
  created_at: string;
  updated_at: string;
};

export type CalendarFeedTokenRow = {
  id: string;
  user_id: string;
  token_prefix: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

// Loose Insert/Update: handlers build explicit literal objects, so a permissive
// partial shape is enough for the Supabase client generics.
type TableDef<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] };

export type CalendarDatabase = Omit<AppDatabase, "public"> & {
  public: Omit<AppDatabase["public"], "Tables" | "Functions"> & {
    Tables: AppDatabase["public"]["Tables"] & {
      calendar_series: TableDef<CalendarSeriesRow>;
      calendar_events: TableDef<CalendarEventRow>;
      event_rsvps: TableDef<EventRsvpRow>;
      calendar_feed_tokens: TableDef<CalendarFeedTokenRow>;
    };
    Functions: AppDatabase["public"]["Functions"] & {
      has_active_paid_membership: { Args: { _user_id: string }; Returns: boolean };
    };
  };
};

export type CalendarClient = SupabaseClient<CalendarDatabase>;
