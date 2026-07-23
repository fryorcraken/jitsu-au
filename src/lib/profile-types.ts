// Row/client type aliases for the profiles feature.
//
// `profiles` is newer than the last Lovable types regen, and `waivers` was
// reshaped (person columns dropped, `profile_id` added, `ip_hash` renamed to
// `signer_ip`), so the generated `integrations/supabase/types.ts` is stale for
// both. This module hand-writes the current rows and layers them onto the
// memberships-aware Database. Once Lovable regenerates the types, these aliases
// can collapse to the generated definitions.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MembershipDatabase } from "@/lib/membership-types";

/** One person, keyed by email. Everything but email/booleans is nullable. */
export type ProfileRow = {
  id: string;
  email: string;
  user_id: string | null;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  date_of_birth: string | null;
  address: string | null;
  phone: string | null;
  uts_student_number: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  medical_notes: string | null;
  is_minor: boolean;
  guardian_name: string | null;
  guardian_relationship: string | null;
  sms_whatsapp_consent: boolean;
  created_at: string;
  updated_at: string;
};

/** The reshaped, slim waiver: the signed artifact only. */
export type WaiverRow = {
  id: string;
  profile_id: string;
  pdf_path: string | null;
  template_version: number | null;
  signer_ip: string | null;
  approval_status: string;
  approved_at: string | null;
  approved_by: string | null;
  signed_at: string;
  created_at: string;
};

// Loose Insert/Update: the server functions build explicit literal objects, so a
// permissive partial shape is enough to satisfy the Supabase client generics.
type TableDef<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] };

/** The memberships-aware Database, with `profiles` added and `waivers` reshaped. */
export type AppDatabase = Omit<MembershipDatabase, "public"> & {
  public: Omit<MembershipDatabase["public"], "Tables"> & {
    Tables: Omit<MembershipDatabase["public"]["Tables"], "waivers"> & {
      profiles: TableDef<ProfileRow>;
      waivers: TableDef<WaiverRow>;
    };
  };
};

export type AppClient = SupabaseClient<AppDatabase>;
