// Row/client type aliases for the profiles + waiver-submission model.
//
// A person = an auth user (their email lives on auth.users, the ONLY email
// store) + a `profiles` row keyed by that user id holding the person fields.
// `profiles` and the reshaped `waivers` are newer than the last Lovable types
// regen, so this module hand-writes the current rows (and the service-role
// helper RPCs) and layers them onto the memberships-aware Database. Once
// Lovable regenerates the types, these aliases can collapse to the generated
// definitions.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MembershipDatabase } from "@/lib/membership-types";

/**
 * The person fields for one auth user. Starts as a lightweight applicant
 * profile (maybe just a name/phone; the email lives on auth.users); full
 * details are copied in when a manager approves a waiver.
 */
export type ProfileRow = {
  user_id: string;
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

/**
 * A waiver: a frozen submission. The person fields (including the email) are
 * exactly what was typed — evidence + the source approval copies from, never
 * the live person record. No full_name (composed), no signature columns (the
 * signatures live inside the PDF).
 */
export type WaiverRow = {
  id: string;
  user_id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  date_of_birth: string;
  address: string;
  phone: string;
  email: string;
  uts_student_number: string | null;
  sms_whatsapp_consent: boolean;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  medical_notes: string | null;
  is_minor: boolean;
  guardian_name: string | null;
  guardian_relationship: string | null;
  pdf_path: string | null;
  template_version: number | null;
  signer_ip: string | null;
  signer_meta: Record<string, unknown>;
  approval_status: string;
  approved_at: string | null;
  approved_by: string | null;
  signed_at: string;
  created_at: string;
};

// Loose Insert/Update: the server functions build explicit literal objects, so a
// permissive partial shape is enough to satisfy the Supabase client generics.
type TableDef<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] };

/**
 * The memberships-aware Database, with `profiles` added, `waivers` reshaped,
 * and the service-role auth lookup RPCs declared.
 */
export type AppDatabase = Omit<MembershipDatabase, "public"> & {
  public: Omit<MembershipDatabase["public"], "Tables" | "Functions"> & {
    Tables: Omit<MembershipDatabase["public"]["Tables"], "waivers"> & {
      profiles: TableDef<ProfileRow>;
      waivers: TableDef<WaiverRow>;
    };
    Functions: MembershipDatabase["public"]["Functions"] & {
      user_id_by_email: { Args: { _email: string }; Returns: string | null };
      user_emails: {
        Args: { _user_ids: string[] };
        Returns: { user_id: string; email: string }[];
      };
    };
  };
};

export type AppClient = SupabaseClient<AppDatabase>;
