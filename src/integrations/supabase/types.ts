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
      blog_blocked_commenters: {
        Row: {
          blocked_at: string
          blocked_by: string | null
          reason: string | null
          user_id: string
        }
        Insert: {
          blocked_at?: string
          blocked_by?: string | null
          reason?: string | null
          user_id: string
        }
        Update: {
          blocked_at?: string
          blocked_by?: string | null
          reason?: string | null
          user_id?: string
        }
        Relationships: []
      }
      blog_comment_upvotes: {
        Row: {
          comment_id: string
          created_at: string
          user_id: string
        }
        Insert: {
          comment_id: string
          created_at?: string
          user_id: string
        }
        Update: {
          comment_id?: string
          created_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "blog_comment_upvotes_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "blog_comments"
            referencedColumns: ["id"]
          },
        ]
      }
      blog_comments: {
        Row: {
          body: string
          created_at: string
          hidden_at: string | null
          hidden_by: string | null
          hidden_reason: string | null
          id: string
          parent_comment_id: string | null
          post_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          hidden_at?: string | null
          hidden_by?: string | null
          hidden_reason?: string | null
          id?: string
          parent_comment_id?: string | null
          post_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          hidden_at?: string | null
          hidden_by?: string | null
          hidden_reason?: string | null
          id?: string
          parent_comment_id?: string | null
          post_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "blog_comments_parent_comment_id_fkey"
            columns: ["parent_comment_id"]
            isOneToOne: false
            referencedRelation: "blog_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blog_comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "blog_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      blog_posts: {
        Row: {
          author_id: string | null
          body_md: string
          cover_image_path: string | null
          created_at: string
          excerpt: string | null
          id: string
          published_at: string | null
          slug: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body_md: string
          cover_image_path?: string | null
          created_at?: string
          excerpt?: string | null
          id?: string
          published_at?: string | null
          slug: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body_md?: string
          cover_image_path?: string | null
          created_at?: string
          excerpt?: string | null
          id?: string
          published_at?: string | null
          slug?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      calendar_events: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          ends_at: string
          id: string
          instructor_name: string | null
          invite_only: boolean
          location: string | null
          series_id: string | null
          starts_at: string
          status: string
          title: string
          updated_at: string
          visibility: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          ends_at: string
          id?: string
          instructor_name?: string | null
          invite_only?: boolean
          location?: string | null
          series_id?: string | null
          starts_at: string
          status?: string
          title: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          ends_at?: string
          id?: string
          instructor_name?: string | null
          invite_only?: boolean
          location?: string | null
          series_id?: string | null
          starts_at?: string
          status?: string
          title?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_events_series_id_fkey"
            columns: ["series_id"]
            isOneToOne: false
            referencedRelation: "calendar_series"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_feed_tokens: {
        Row: {
          created_at: string
          id: string
          last_used_at: string | null
          revoked_at: string | null
          token: string | null
          token_hash: string
          token_prefix: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          revoked_at?: string | null
          token?: string | null
          token_hash: string
          token_prefix: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          revoked_at?: string | null
          token?: string | null
          token_hash?: string
          token_prefix?: string
          user_id?: string
        }
        Relationships: []
      }
      calendar_series: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          duration_minutes: number
          ends_on: string | null
          id: string
          instructor_name: string | null
          invite_only: boolean
          is_active: boolean
          location: string | null
          start_time: string
          starts_on: string
          title: string
          updated_at: string
          visibility: string
          weekday: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          duration_minutes: number
          ends_on?: string | null
          id?: string
          instructor_name?: string | null
          invite_only?: boolean
          is_active?: boolean
          location?: string | null
          start_time: string
          starts_on: string
          title: string
          updated_at?: string
          visibility?: string
          weekday: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          duration_minutes?: number
          ends_on?: string | null
          id?: string
          instructor_name?: string | null
          invite_only?: boolean
          is_active?: boolean
          location?: string | null
          start_time?: string
          starts_on?: string
          title?: string
          updated_at?: string
          visibility?: string
          weekday?: number
        }
        Relationships: []
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
      code_of_conduct_acceptances: {
        Row: {
          accepted_at: string
          created_at: string
          email: string
          full_name: string
          id: string
          signature_name: string
          signer_ip: string | null
          signer_meta: Json
          user_id: string
          version: number
        }
        Insert: {
          accepted_at?: string
          created_at?: string
          email: string
          full_name: string
          id?: string
          signature_name: string
          signer_ip?: string | null
          signer_meta?: Json
          user_id: string
          version: number
        }
        Update: {
          accepted_at?: string
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          signature_name?: string
          signer_ip?: string | null
          signer_meta?: Json
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "code_of_conduct_acceptances_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      contact_messages: {
        Row: {
          client_submission_id: string | null
          created_at: string
          email: string
          id: string
          message: string
          name: string
          subject: string | null
        }
        Insert: {
          client_submission_id?: string | null
          created_at?: string
          email: string
          id?: string
          message: string
          name: string
          subject?: string | null
        }
        Update: {
          client_submission_id?: string | null
          created_at?: string
          email?: string
          id?: string
          message?: string
          name?: string
          subject?: string | null
        }
        Relationships: []
      }
      email_verification_tokens: {
        Row: {
          created_at: string
          email: string
          expires_at: string
          id: string
          last_used_at: string | null
          purpose: string
          revoked_at: string | null
          token_hash: string
          token_prefix: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          email: string
          expires_at: string
          id?: string
          last_used_at?: string | null
          purpose: string
          revoked_at?: string | null
          token_hash: string
          token_prefix: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          last_used_at?: string | null
          purpose?: string
          revoked_at?: string | null
          token_hash?: string
          token_prefix?: string
          user_id?: string | null
        }
        Relationships: []
      }
      event_rsvps: {
        Row: {
          created_at: string
          event_id: string
          id: string
          response: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          response: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          response?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_rsvps_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "calendar_events"
            referencedColumns: ["id"]
          },
        ]
      }
      interest_registrations: {
        Row: {
          client_submission_id: string | null
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
          client_submission_id?: string | null
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
          client_submission_id?: string | null
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
      kb_annotations: {
        Row: {
          article_id: string
          article_version: number
          block_id: string | null
          body: string
          created_at: string
          id: string
          parent_id: string | null
          quote: string | null
          resolved_at: string | null
          resolved_by: string | null
          updated_at: string
          user_id: string
          visibility: string
        }
        Insert: {
          article_id: string
          article_version: number
          block_id?: string | null
          body: string
          created_at?: string
          id?: string
          parent_id?: string | null
          quote?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          updated_at?: string
          user_id: string
          visibility: string
        }
        Update: {
          article_id?: string
          article_version?: number
          block_id?: string | null
          body?: string
          created_at?: string
          id?: string
          parent_id?: string | null
          quote?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          updated_at?: string
          user_id?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "kb_annotations_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "kb_articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kb_annotations_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "kb_annotations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kb_annotations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      kb_article_reads: {
        Row: {
          article_id: string
          read_at: string
          user_id: string
          version: number
        }
        Insert: {
          article_id: string
          read_at?: string
          user_id: string
          version: number
        }
        Update: {
          article_id?: string
          read_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "kb_article_reads_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "kb_articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kb_article_reads_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      kb_article_versions: {
        Row: {
          article_id: string
          body_md: string
          change_note: string | null
          created_at: string
          created_by: string | null
          id: string
          is_current: boolean
          title: string
          version: number
        }
        Insert: {
          article_id: string
          body_md: string
          change_note?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_current?: boolean
          title: string
          version: number
        }
        Update: {
          article_id?: string
          body_md?: string
          change_note?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_current?: boolean
          title?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "kb_article_versions_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "kb_articles"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_articles: {
        Row: {
          annotations_enabled: boolean
          created_at: string
          created_by: string | null
          id: string
          link_path: string | null
          nav_title: string | null
          position: number
          section_id: string | null
          slug: string
          updated_at: string
          visibility: string
        }
        Insert: {
          annotations_enabled?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          link_path?: string | null
          nav_title?: string | null
          position?: number
          section_id?: string | null
          slug: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          annotations_enabled?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          link_path?: string | null
          nav_title?: string | null
          position?: number
          section_id?: string | null
          slug?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "kb_articles_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "kb_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_sections: {
        Row: {
          created_at: string
          id: string
          position: number
          slug: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          position?: number
          slug: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          position?: number
          slug?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      manager_api_tokens: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          label: string
          last_used_at: string | null
          revoked_at: string | null
          token_hash: string
          token_prefix: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          label?: string
          last_used_at?: string | null
          revoked_at?: string | null
          token_hash: string
          token_prefix: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          label?: string
          last_used_at?: string | null
          revoked_at?: string | null
          token_hash?: string
          token_prefix?: string
        }
        Relationships: []
      }
      membership_plans: {
        Row: {
          code: string
          created_at: string
          description: string | null
          duration_days: number | null
          ends_on: string | null
          id: string
          is_active: boolean
          kind: string
          name: string
          public_price_cents: number
          session_credits: number | null
          sort_order: number
          starts_on: string | null
          student_price_cents: number | null
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          duration_days?: number | null
          ends_on?: string | null
          id?: string
          is_active?: boolean
          kind: string
          name: string
          public_price_cents: number
          session_credits?: number | null
          sort_order?: number
          starts_on?: string | null
          student_price_cents?: number | null
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          duration_days?: number | null
          ends_on?: string | null
          id?: string
          is_active?: boolean
          kind?: string
          name?: string
          public_price_cents?: number
          session_credits?: number | null
          sort_order?: number
          starts_on?: string | null
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
          belt_size: string | null
          created_at: string
          date_of_birth: string | null
          display_name: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          emergency_contact_relationship: string | null
          first_name: string
          gi_size: string | null
          guardian_name: string | null
          guardian_relationship: string | null
          is_minor: boolean
          last_name: string | null
          media_consent: boolean | null
          media_consent_updated_at: string | null
          media_consent_updated_by: string | null
          medical_notes: string | null
          middle_name: string | null
          phone: string | null
          preferred_name: string | null
          sms_whatsapp_consent: boolean
          updated_at: string
          user_id: string
          uts_student_number: string | null
        }
        Insert: {
          address?: string | null
          belt_size?: string | null
          created_at?: string
          date_of_birth?: string | null
          display_name?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          first_name: string
          gi_size?: string | null
          guardian_name?: string | null
          guardian_relationship?: string | null
          is_minor?: boolean
          last_name?: string | null
          media_consent?: boolean | null
          media_consent_updated_at?: string | null
          media_consent_updated_by?: string | null
          medical_notes?: string | null
          middle_name?: string | null
          phone?: string | null
          preferred_name?: string | null
          sms_whatsapp_consent?: boolean
          updated_at?: string
          user_id: string
          uts_student_number?: string | null
        }
        Update: {
          address?: string | null
          belt_size?: string | null
          created_at?: string
          date_of_birth?: string | null
          display_name?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          first_name?: string
          gi_size?: string | null
          guardian_name?: string | null
          guardian_relationship?: string | null
          is_minor?: boolean
          last_name?: string | null
          media_consent?: boolean | null
          media_consent_updated_at?: string | null
          media_consent_updated_by?: string | null
          medical_notes?: string | null
          middle_name?: string | null
          phone?: string | null
          preferred_name?: string | null
          sms_whatsapp_consent?: boolean
          updated_at?: string
          user_id?: string
          uts_student_number?: string | null
        }
        Relationships: []
      }
      session_checkins: {
        Row: {
          checked_in_at: string
          checked_in_by: string | null
          closed_membership: boolean
          consumed_credit: boolean
          coverage: string
          event_id: string
          id: string
          membership_id: string | null
          note: string | null
          user_id: string
          warnings: string[]
        }
        Insert: {
          checked_in_at?: string
          checked_in_by?: string | null
          closed_membership?: boolean
          consumed_credit?: boolean
          coverage?: string
          event_id: string
          id?: string
          membership_id?: string | null
          note?: string | null
          user_id: string
          warnings?: string[]
        }
        Update: {
          checked_in_at?: string
          checked_in_by?: string | null
          closed_membership?: boolean
          consumed_credit?: boolean
          coverage?: string
          event_id?: string
          id?: string
          membership_id?: string | null
          note?: string | null
          user_id?: string
          warnings?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "session_checkins_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "calendar_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_checkins_membership_id_fkey"
            columns: ["membership_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_checkins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
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
          acknowledgements: Json
          body_md: string
          created_at: string
          created_by: string | null
          id: string
          is_current: boolean
          title: string
          version: number
        }
        Insert: {
          acknowledgements?: Json
          body_md: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_current?: boolean
          title?: string
          version: number
        }
        Update: {
          acknowledgements?: Json
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
          approval_status: string
          approved_at: string | null
          approved_by: string | null
          client_submission_id: string | null
          created_at: string
          date_of_birth: string
          email: string
          emergency_contact_name: string
          emergency_contact_phone: string
          emergency_contact_relationship: string | null
          first_name: string
          guardian_name: string | null
          guardian_relationship: string | null
          id: string
          is_minor: boolean
          last_name: string
          media_consent: boolean | null
          medical_notes: string | null
          middle_name: string | null
          pdf_path: string | null
          phone: string
          preferred_name: string | null
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
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          client_submission_id?: string | null
          created_at?: string
          date_of_birth: string
          email: string
          emergency_contact_name: string
          emergency_contact_phone: string
          emergency_contact_relationship?: string | null
          first_name: string
          guardian_name?: string | null
          guardian_relationship?: string | null
          id?: string
          is_minor?: boolean
          last_name: string
          media_consent?: boolean | null
          medical_notes?: string | null
          middle_name?: string | null
          pdf_path?: string | null
          phone: string
          preferred_name?: string | null
          signed_at?: string
          signer_ip?: string | null
          signer_meta?: Json
          sms_whatsapp_consent?: boolean
          template_version?: number | null
          user_id: string
          uts_student_number?: string | null
        }
        Update: {
          address?: string
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          client_submission_id?: string | null
          created_at?: string
          date_of_birth?: string
          email?: string
          emergency_contact_name?: string
          emergency_contact_phone?: string
          emergency_contact_relationship?: string | null
          first_name?: string
          guardian_name?: string | null
          guardian_relationship?: string | null
          id?: string
          is_minor?: boolean
          last_name?: string
          media_consent?: boolean | null
          medical_notes?: string | null
          middle_name?: string | null
          pdf_path?: string | null
          phone?: string
          preferred_name?: string | null
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
      clear_email_confirmation: {
        Args: { _user_id: string }
        Returns: undefined
      }
      has_active_paid_membership: {
        Args: { _user_id: string }
        Returns: boolean
      }
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
          email_confirmed_at: string
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
