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

export type ManagerApiTokenRow = {
  id: string;
  label: string;
  token_prefix: string;
  token_hash: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

// Loose Insert/Update: the server functions build explicit literal objects, so a
// permissive partial shape is enough to satisfy the Supabase client generics.
type TableDef<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] };

// The membership tables are now in the generated types, so they alias directly
// above. `manager_api_tokens` is newer than the last Lovable types regen, so we
// still layer just that one table onto the generated Database. Once Lovable
// regenerates the types, this can collapse to `export type MembershipDatabase =
// Database` and `MembershipClient = SupabaseClient<Database>`.
export type MembershipDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Database["public"]["Tables"] & {
      manager_api_tokens: TableDef<ManagerApiTokenRow>;
    };
  };
};

export type MembershipClient = SupabaseClient<MembershipDatabase>;
