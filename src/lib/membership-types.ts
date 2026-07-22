// Row/client type aliases for the memberships feature.
//
// These tables (`membership_plans`, `memberships`, `bank_transactions`,
// `club_settings`) used to be missing from the generated
// `integrations/supabase/types.ts`, so this module hand-wrote them and layered
// them onto a bespoke `Database`. Lovable now regenerates the types with these
// tables included, so we alias the generated definitions directly (as the old
// comment here always anticipated). The generated rows widen the enum/text
// columns (`kind`, `status`, `payment_method`) to `string`; the narrow unions
// live in `@/lib/validation` and are applied at the call sites that need them.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Tables = Database["public"]["Tables"];

export type MembershipPlanRow = Tables["membership_plans"]["Row"];
export type MembershipRow = Tables["memberships"]["Row"];
export type BankTransactionRow = Tables["bank_transactions"]["Row"];
export type ClubSettingRow = Tables["club_settings"]["Row"];

export type MembershipDatabase = Database;
export type MembershipClient = SupabaseClient<Database>;
