export type CandidateStatus =
  | 'Pending'
  | 'Interview Scheduled'
  | 'Interview Completed'
  | 'Selected'
  | 'Rejected'
  | 'Hold'
  | 'Offer Released'
  | 'Joined'

/** Recruiter-selected next action for a candidate — independent of CandidateStatus. */
export type CandidateAction =
  | 'Interview Reject - Adobe'
  | 'Reviewed earlier (SR) - Adobe'
  | 'Reviewed earlier (TR) - Adobe'
  | 'Interview stage - Adobe'
  | 'Interview stage - HireSense'
  | 'Offer - Adobe'
  | 'Offer - HireSense'
  | 'Screen Select'
  | 'Screen Reject'

export type UserRole = 'super_admin' | 'admin' | 'viewer'

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          name: string | null
          email: string
          role: UserRole
          created_at: string
          failed_login_attempts: number
          locked_at: string | null
          lock_expires_at: string | null
          last_failed_login_at: string | null
          force_password_change: boolean
        }
        Insert: {
          id: string
          name?: string | null
          email: string
          role?: UserRole
          created_at?: string
          failed_login_attempts?: number
          locked_at?: string | null
          lock_expires_at?: string | null
          last_failed_login_at?: string | null
          force_password_change?: boolean
        }
        Update: {
          id?: string
          name?: string | null
          email?: string
          role?: UserRole
          created_at?: string
          failed_login_attempts?: number
          locked_at?: string | null
          lock_expires_at?: string | null
          last_failed_login_at?: string | null
          force_password_change?: boolean
        }
        Relationships: []
      }
      dashboards: {
        Row: {
          id: string
          title: string
          description: string | null
          file_name: string
          storage_path: string
          thumbnail: string | null
          category: string | null
          created_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          title: string
          description?: string | null
          file_name: string
          storage_path: string
          thumbnail?: string | null
          category?: string | null
          created_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          title?: string
          description?: string | null
          file_name?: string
          storage_path?: string
          thumbnail?: string | null
          category?: string | null
          created_by?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'dashboards_created_by_fkey'
            columns: ['created_by']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      dashboard_status: {
        Row: {
          id: string
          dashboard_id: string
          candidate_name: string
          candidate_email: string | null
          status: CandidateStatus
          action: CandidateAction | null
          remarks: string | null
          updated_by: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          dashboard_id: string
          candidate_name: string
          candidate_email?: string | null
          status?: CandidateStatus
          action?: CandidateAction | null
          remarks?: string | null
          updated_by?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          dashboard_id?: string
          candidate_name?: string
          candidate_email?: string | null
          status?: CandidateStatus
          action?: CandidateAction | null
          remarks?: string | null
          updated_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'dashboard_status_dashboard_id_fkey'
            columns: ['dashboard_id']
            isOneToOne: false
            referencedRelation: 'dashboards'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'dashboard_status_updated_by_fkey'
            columns: ['updated_by']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      candidate_notes: {
        Row: {
          id: string
          dashboard_id: string
          candidate_name: string
          note: string | null
          created_by: string | null
          created_at: string
          updated_by: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          dashboard_id: string
          candidate_name: string
          note?: string | null
          created_by?: string | null
          created_at?: string
          updated_by?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          dashboard_id?: string
          candidate_name?: string
          note?: string | null
          created_by?: string | null
          created_at?: string
          updated_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'candidate_notes_dashboard_id_fkey'
            columns: ['dashboard_id']
            isOneToOne: false
            referencedRelation: 'dashboards'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'candidate_notes_created_by_fkey'
            columns: ['created_by']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'candidate_notes_updated_by_fkey'
            columns: ['updated_by']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
    }
    Views: Record<string, never>
    Functions: {
      is_admin: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

export type Profile = Database['public']['Tables']['profiles']['Row']
export type Dashboard = Database['public']['Tables']['dashboards']['Row']
export type DashboardStatus =
  Database['public']['Tables']['dashboard_status']['Row']
export type DashboardStatusInsert =
  Database['public']['Tables']['dashboard_status']['Insert']
export type DashboardStatusUpdate =
  Database['public']['Tables']['dashboard_status']['Update']
export type CandidateNote =
  Database['public']['Tables']['candidate_notes']['Row']
export type CandidateNoteInsert =
  Database['public']['Tables']['candidate_notes']['Insert']
export type CandidateNoteUpdate =
  Database['public']['Tables']['candidate_notes']['Update']
