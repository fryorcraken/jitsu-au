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
          uts_student?: boolean
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
          acknowledgements: Json
          address: string
          created_at: string
          date_of_birth: string
          email: string
          emergency_contact_name: string
          emergency_contact_phone: string
          first_name: string | null
          full_name: string
          guardian_name: string | null
          guardian_relationship: string | null
          guardian_signature: string | null
          guardian_signature_image_path: string | null
          id: string
          ip_hash: string | null
          is_minor: boolean
          last_name: string | null
          medical_notes: string | null
          middle_name: string | null
          pdf_path: string | null
          phone: string
          signature_image_path: string | null
          signature_name: string
          signed_at: string
          template_version: number | null
          user_id: string | null
        }
        Insert: {
          acknowledgements?: Json
          address: string
          created_at?: string
          date_of_birth: string
          email: string
          emergency_contact_name: string
          emergency_contact_phone: string
          first_name?: string | null
          full_name: string
          guardian_name?: string | null
          guardian_relationship?: string | null
          guardian_signature?: string | null
          guardian_signature_image_path?: string | null
          id?: string
          ip_hash?: string | null
          is_minor?: boolean
          last_name?: string | null
          medical_notes?: string | null
          middle_name?: string | null
          pdf_path?: string | null
          phone: string
          signature_image_path?: string | null
          signature_name: string
          signed_at?: string
          template_version?: number | null
          user_id?: string | null
        }
        Update: {
          acknowledgements?: Json
          address?: string
          created_at?: string
          date_of_birth?: string
          email?: string
          emergency_contact_name?: string
          emergency_contact_phone?: string
          first_name?: string | null
          full_name?: string
          guardian_name?: string | null
          guardian_relationship?: string | null
          guardian_signature?: string | null
          guardian_signature_image_path?: string | null
          id?: string
          ip_hash?: string | null
          is_minor?: boolean
          last_name?: string | null
          medical_notes?: string | null
          middle_name?: string | null
          pdf_path?: string | null
          phone?: string
          signature_image_path?: string | null
          signature_name?: string
          signed_at?: string
          template_version?: number | null
          user_id?: string | null
        }
        Relationships: []
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
