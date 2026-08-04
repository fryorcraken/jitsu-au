// Row/client type aliases for the memberships feature.
//
// Every table here is now in the generated `integrations/supabase/types.ts`, so
// each alias points straight at the generated definition and nothing in this
// module hand-writes a row shape. That matters beyond tidiness: the generated
// types are the only artifact derived from the *live* database, so a
// hand-written row that claims a column the live DB lacks silently hides
// schema drift from the compiler (see "Schema drift" in CLAUDE.md).
//
// The generated rows widen the enum/text columns (`kind`, `status`,
// `payment_method`) to `string`; the narrow unions live in `@/lib/validation`
// and are applied at the call sites that need them.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Tables = Database["public"]["Tables"];

export type MembershipPlanRow = Tables["membership_plans"]["Row"];
export type MembershipRow = Tables["memberships"]["Row"];
export type BankTransactionRow = Tables["bank_transactions"]["Row"];
export type ClubSettingRow = Tables["club_settings"]["Row"];
export type ManagerApiTokenRow = Tables["manager_api_tokens"]["Row"];

export type MembershipDatabase = Database;
export type MembershipClient = SupabaseClient<Database>;
