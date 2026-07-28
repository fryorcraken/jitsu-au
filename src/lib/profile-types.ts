// Row/client type aliases for the profiles + waiver-submission model.
//
// A person = an auth user (their email lives on auth.users, the ONLY email
// store) + a `profiles` row keyed by that user id holding the person fields.
//
// Both rows now come straight from the generated
// `integrations/supabase/types.ts`. This module used to hand-write them and
// layer them onto the Database, which is how `waivers.approval_status` could go
// missing from the live database for a week without the compiler noticing: the
// hand-written row asserted the column into existence. The generated types are
// the only artifact derived from the live database, so they stay authoritative
// here (see "Schema drift" in CLAUDE.md).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Tables = Database["public"]["Tables"];

/**
 * The person fields for one auth user. Starts as a lightweight applicant
 * profile (maybe just a name/phone; the email lives on auth.users); full
 * details are copied in when a manager approves a waiver.
 */
export type ProfileRow = Tables["profiles"]["Row"];

/**
 * A waiver: a frozen submission. The person fields (including the email) are
 * exactly what was typed — evidence + the source approval copies from, never
 * the live person record. No full_name (composed), no signature columns (the
 * signatures live inside the PDF).
 */
export type WaiverRow = Tables["waivers"]["Row"];

export type AppDatabase = Database;
export type AppClient = SupabaseClient<Database>;
