export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_user_connections: {
        Row: {
          connected_email: string | null
          connection_key_ciphertext: string
          connector_id: string
          created_at: string
          id: string
          metadata: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          connected_email?: string | null
          connection_key_ciphertext: string
          connector_id: string
          created_at?: string
          id?: string
          metadata?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          connected_email?: string | null
          connection_key_ciphertext?: string
          connector_id?: string
          created_at?: string
          id?: string
          metadata?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      bank_transactions: {
        Row: {
          amount_cents: number
          created_at: string
          dedupe_hash: string
          description: string
          id: string
          import_batch: string
          matched_at: string | null
          matched_by: string | null
          matched_membership_id: string | null
          posted_at: string | null
          raw: Json
          reference: string | null
          status: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          dedupe_hash: string
          description?: string
          id?: string
          import_batch: string
          matched_at?: string | null
          matched_by?: string | null
          matched_membership_id?: string | null
          posted_at?: string | null
          raw?: Json
          reference?: string | null
          status?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          dedupe_hash?: string
          description?: string
          id?: string
          import_batch?: string
          matched_at?: string | null
          matched_by?: string | null
          matched_membership_id?: string | null
          posted_at?: string | null
          raw?: Json
          reference?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_transactions_matched_membership_id_fkey"
            columns: ["matched_membership_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      club_settings: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: string
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value?: string
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: string
        }
        Relationships: []
      }
      contact_messages: {
        Row: {
          created_at: string
          email: string
          id: string
          message: string
          name: string
          subject: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          message: string
          name: string
          subject?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          message?: string
          name?: string
          subject?: string | null
        }
        Relationships: []
      }
      interest_registrations: {
        Row: {
          created_at: string
          email: string
          experience: string | null
          id: string
          message: string | null
          name: string
          phone: string | null
          sms_whatsapp_consent: boolean
          uts_student: boolean
        }
        Insert: {
          created_at?: string
          email: string
          experience?: string | null
          id?: string
          message?: string | null
          name: string
          phone?: string | null
          sms_whatsapp_consent?: boolean
          uts_student?: boolean
        }
        Update: {
          created_at?: string
          email?: string
          experience?: string | null
          id?: string
          message?: string | null
          name?: string
          phone?: string | null
          sms_whatsapp_consent?: boolean
          uts_student?: boolean
        }
        Relationships: []
      }
      membership_plans: {
        Row: {
          code: string
          created_at: string
          description: string | null
          duration_days: number | null
          id: string
          is_active: boolean
          kind: string
          name: string
          public_price_cents: number
          session_credits: number | null
          sort_order: number
          student_price_cents: number | null
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          duration_days?: number | null
          id?: string
          is_active?: boolean
          kind: string
          name: string
          public_price_cents: number
          session_credits?: number | null
          sort_order?: number
          student_price_cents?: number | null
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          duration_days?: number | null
          id?: string
          is_active?: boolean
          kind?: string
          name?: string
          public_price_cents?: number
          session_credits?: number | null
          sort_order?: number
          student_price_cents?: number | null
        }
        Relationships: []
      }
      memberships: {
        Row: {
          created_at: string
          ends_at: string | null
          id: string
          is_student: boolean
          notes: string | null
          paid_at: string | null
          payment_method: string
          payment_reference: string
          plan_id: string
          price_cents: number
          session_date: string | null
          sessions_remaining: number | null
          starts_at: string | null
          status: string
          user_id: string | null
          uts_student_number: string | null
        }
        Insert: {
          created_at?: string
          ends_at?: string | null
          id?: string
          is_student?: boolean
          notes?: string | null
          paid_at?: string | null
          payment_method?: string
          payment_reference: string
          plan_id: string
          price_cents: number
          session_date?: string | null
          sessions_remaining?: number | null
          starts_at?: string | null
          status?: string
          user_id?: string | null
          uts_student_number?: string | null
        }
        Update: {
          created_at?: string
          ends_at?: string | null
          id?: string
          is_student?: boolean
          notes?: string | null
          paid_at?: string | null
          payment_method?: string
          payment_reference?: string
          plan_id?: string
          price_cents?: number
          session_date?: string | null
          sessions_remaining?: number | null
          starts_at?: string | null
          status?: string
          user_id?: string | null
          uts_student_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "memberships_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "membership_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          address: string | null
          created_at: string
          date_of_birth: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          first_name: string | null
          guardian_name: string | null
          guardian_relationship: string | null
          is_minor: boolean
          last_name: string | null
          medical_notes: string | null
          middle_name: string | null
          phone: string | null
          sms_whatsapp_consent: boolean
          updated_at: string
          user_id: string
          uts_student_number: string | null
        }
        Insert: {
          address?: string | null
          created_at?: string
          date_of_birth?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          first_name?: string | null
          guardian_name?: string | null
          guardian_relationship?: string | null
          is_minor?: boolean
          last_name?: string | null
          medical_notes?: string | null
          middle_name?: string | null
          phone?: string | null
          sms_whatsapp_consent?: boolean
          updated_at?: string
          user_id: string
          uts_student_number?: string | null
        }
        Update: {
          address?: string | null
          created_at?: string
          date_of_birth?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          first_name?: string | null
          guardian_name?: string | null
          guardian_relationship?: string | null
          is_minor?: boolean
          last_name?: string | null
          medical_notes?: string | null
          middle_name?: string | null
          phone?: string | null
          sms_whatsapp_consent?: boolean
          updated_at?: string
          user_id?: string
          uts_student_number?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      waiver_drive_uploads: {
        Row: {
          drive_file_id: string
          drive_web_view_link: string | null
          id: string
          manager_user_id: string
          uploaded_at: string
          waiver_id: string
        }
        Insert: {
          drive_file_id: string
          drive_web_view_link?: string | null
          id?: string
          manager_user_id: string
          uploaded_at?: string
          waiver_id: string
        }
        Update: {
          drive_file_id?: string
          drive_web_view_link?: string | null
          id?: string
          manager_user_id?: string
          uploaded_at?: string
          waiver_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiver_drive_uploads_waiver_id_fkey"
            columns: ["waiver_id"]
            isOneToOne: false
            referencedRelation: "waivers"
            referencedColumns: ["id"]
          },
        ]
      }
      waiver_templates: {
        Row: {
          body_md: string
          created_at: string
          created_by: string | null
          id: string
          is_current: boolean
          title: string
          version: number
        }
        Insert: {
          body_md: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_current?: boolean
          title?: string
          version: number
        }
        Update: {
          body_md?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_current?: boolean
          title?: string
          version?: number
        }
        Relationships: []
      }
      waivers: {
        Row: {
          address: string
          created_at: string
          date_of_birth: string
          email: string
          emergency_contact_name: string
          emergency_contact_phone: string
          first_name: string
          guardian_name: string | null
          guardian_relationship: string | null
          id: string
          is_minor: boolean
          last_name: string
          medical_notes: string | null
          middle_name: string | null
          pdf_path: string | null
          phone: string
          signed_at: string
          signer_ip: string | null
          signer_meta: Json
          sms_whatsapp_consent: boolean
          template_version: number | null
          user_id: string
          uts_student_number: string | null
        }
        Insert: {
          address: string
          created_at?: string
          date_of_birth: string
          email: string
          emergency_contact_name: string
          emergency_contact_phone: string
          first_name: string
          guardian_name?: string | null
          guardian_relationship?: string | null
          id?: string
          is_minor?: boolean
          last_name: string
          medical_notes?: string | null
          middle_name?: string | null
          pdf_path?: string | null
          phone: string
          signed_at?: string
          signer_ip?: string | null
          signer_meta?: Json
          sms_whatsapp_consent?: boolean
          template_version?: number | null
          user_id: string
          uts_student_number: string | null
        }
        Update: {
          address?: string
          created_at?: string
          date_of_birth?: string
          email?: string
          emergency_contact_name?: string
          emergency_contact_phone?: string
          first_name?: string
          guardian_name?: string | null
          guardian_relationship?: string | null
          id?: string
          is_minor?: boolean
          last_name?: string
          medical_notes?: string | null
          middle_name?: string | null
          pdf_path?: string | null
          phone?: string
          signed_at?: string
          signer_ip?: string | null
          signer_meta?: Json
          sms_whatsapp_consent?: boolean
          template_version?: number | null
          user_id?: string
          uts_student_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "waivers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      user_emails: {
        Args: { _user_ids: string[] }
        Returns: {
          email: string
          user_id: string
        }[]
      }
      user_id_by_email: { Args: { _email: string }; Returns: string }
    }
    Enums: {
      app_role: "manager" | "member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["manager", "member"],
    },
  },
} as const
