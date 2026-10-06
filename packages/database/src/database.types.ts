export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string | null;
          locale: string;
          timezone: string;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: {
          display_name?: string | null;
          locale?: string;
          timezone?: string;
        };
        Relationships: [];
      };
      workspaces: {
        Row: {
          id: string;
          name: string;
          slug: string;
          created_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      workspace_members: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: Database['public']['Enums']['membership_role'];
          membership_status: Database['public']['Enums']['membership_status'];
          joined_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      audit_logs: {
        Row: {
          id: string;
          workspace_id: string;
          actor_id: string | null;
          action: string;
          target_type: string;
          target_id: string;
          request_id: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      companies: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          description: string | null;
          created_by: string;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          description?: string | null;
          created_by: string;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Update: {
          name?: string;
          description?: string | null;
          updated_at?: string;
          archived_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'companies_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      projects: {
        Row: {
          id: string;
          workspace_id: string;
          company_id: string | null;
          name: string;
          description: string | null;
          created_by: string;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          company_id?: string | null;
          name: string;
          description?: string | null;
          created_by: string;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Update: {
          name?: string;
          description?: string | null;
          updated_at?: string;
          archived_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'projects_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'projects_company_workspace_fkey';
            columns: ['company_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      meeting_type_templates: {
        Row: {
          key: string;
          display_name: string;
          sort_order: number;
          is_active: boolean;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      meeting_types: {
        Row: {
          id: string;
          workspace_id: string;
          key: string;
          display_name: string;
          template_key: string | null;
          sort_order: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'meeting_types_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      meetings: {
        Row: {
          id: string;
          workspace_id: string;
          company_id: string | null;
          project_id: string | null;
          meeting_type_id: string;
          title: string;
          status: Database['public']['Enums']['meeting_status'];
          created_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          company_id?: string | null;
          project_id?: string | null;
          meeting_type_id: string;
          title: string;
          status?: Database['public']['Enums']['meeting_status'];
          created_by: string;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'meetings_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'meetings_company_workspace_fkey';
            columns: ['company_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'meetings_project_workspace_fkey';
            columns: ['project_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'meetings_type_workspace_fkey';
            columns: ['meeting_type_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'meeting_types';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_workspace: {
        Args: { p_name: string; p_slug: string };
        Returns: string;
      };
    };
    Enums: {
      membership_role: 'owner' | 'admin' | 'member';
      membership_status: 'invited' | 'active' | 'suspended';
      meeting_status: 'draft';
    };
    CompositeTypes: Record<string, never>;
  };
};
