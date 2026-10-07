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
          processing_status: Database['public']['Enums']['meeting_processing_status'];
          started_at: string | null;
          ended_at: string | null;
          timeline_origin_at: string | null;
          timeline_duration_ms: number | null;
          active_capture_duration_ms: number | null;
          current_transcription_run_id: string | null;
          latest_transcription_run_id: string | null;
          current_analysis_run_id: string | null;
          latest_analysis_run_id: string | null;
          current_embedding_run_id: string | null;
          latest_embedding_run_id: string | null;
          detected_languages: string[];
          deleted_at: string | null;
          purge_status: 'active' | 'tombstoned' | 'purge_pending' | 'purged';
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
          processing_status?: Database['public']['Enums']['meeting_processing_status'];
          started_at?: string | null;
          ended_at?: string | null;
          timeline_origin_at?: string | null;
          timeline_duration_ms?: number | null;
          active_capture_duration_ms?: number | null;
          current_transcription_run_id?: string | null;
          latest_transcription_run_id?: string | null;
          current_analysis_run_id?: string | null;
          latest_analysis_run_id?: string | null;
          current_embedding_run_id?: string | null;
          latest_embedding_run_id?: string | null;
          detected_languages?: string[];
          deleted_at?: string | null;
          purge_status?: 'active' | 'tombstoned' | 'purge_pending' | 'purged';
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
      recordings: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          session_id: string;
          status: Database['public']['Enums']['recording_status'];
          clock_kind: string;
          clock_epoch_id: string;
          origin_ticks: string;
          origin_wall_clock_utc: string;
          tick_frequency_hz: number;
          canonical_duration_ms: number | null;
          active_capture_ms: number | null;
          started_at: string;
          stopped_at: string | null;
          finalized_at: string | null;
          consent_acknowledged_at: string;
          consent_policy_version: string;
          manifest_revision: number;
          timeline_metadata: Json;
          created_by: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          meeting_id: string;
          session_id: string;
          status?: Database['public']['Enums']['recording_status'];
          clock_kind?: string;
          clock_epoch_id: string;
          origin_ticks: string;
          origin_wall_clock_utc: string;
          tick_frequency_hz: number;
          canonical_duration_ms?: number | null;
          active_capture_ms?: number | null;
          started_at?: string;
          consent_acknowledged_at: string;
          consent_policy_version?: string;
          manifest_revision?: number;
          timeline_metadata?: Json;
          created_by: string;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'recordings_meeting_workspace_fkey';
            columns: ['meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'meetings';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      recording_sources: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          recording_id: string;
          source_kind: Database['public']['Enums']['recording_source_kind'];
          source_role: Database['public']['Enums']['recording_source_role'];
          is_required: boolean;
          device_uid: string | null;
          device_name: string | null;
          started_at_ticks: string | null;
          ended_at_ticks: string | null;
          first_sample_index: number;
          last_sample_index_exclusive: number | null;
          first_sample_meeting_ms: number;
          last_sample_meeting_ms: number | null;
          dropped_sample_count: number;
          expected_chunk_count: number | null;
          capture_metadata: Json;
          codec: string;
          container: string;
          sample_rate_hz: number;
          channels: number;
          format_metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          meeting_id: string;
          recording_id: string;
          source_kind: Database['public']['Enums']['recording_source_kind'];
          source_role?: Database['public']['Enums']['recording_source_role'];
          is_required?: boolean;
          device_uid?: string | null;
          device_name?: string | null;
          started_at_ticks?: string | null;
          ended_at_ticks?: string | null;
          first_sample_index?: number;
          last_sample_index_exclusive?: number | null;
          first_sample_meeting_ms?: number;
          last_sample_meeting_ms?: number | null;
          dropped_sample_count?: number;
          expected_chunk_count?: number | null;
          capture_metadata?: Json;
          codec: string;
          container: string;
          sample_rate_hz: number;
          channels: number;
          format_metadata?: Json;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'recording_sources_recording_meeting_workspace_fkey';
            columns: ['recording_id', 'meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'recordings';
            referencedColumns: ['id', 'meeting_id', 'workspace_id'];
          },
        ];
      };
      recording_chunks: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          recording_id: string;
          recording_source_id: string;
          client_chunk_id: string;
          idempotency_key: string;
          sequence_no: number;
          meeting_start_ms: number;
          meeting_end_ms: number;
          duration_ms: number;
          sample_start: number;
          sample_end: number;
          first_sample_monotonic_ticks: string;
          byte_size: number;
          checksum_algorithm: string;
          checksum_sha256: string;
          storage_backend: string;
          storage_key: string;
          upload_state: Database['public']['Enums']['chunk_upload_state'];
          verification_state: Database['public']['Enums']['chunk_verification_state'];
          codec: string;
          container: string;
          sample_rate_hz: number;
          channels: number;
          encoder_delay_samples: number;
          encoder_padding_samples: number;
          verified_byte_size: number | null;
          verified_sha256: string | null;
          verification_method: string | null;
          verification_error_code: string | null;
          created_at: string;
          updated_at: string;
          uploaded_at: string | null;
          verified_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          meeting_id: string;
          recording_id: string;
          recording_source_id: string;
          client_chunk_id: string;
          idempotency_key: string;
          sequence_no: number;
          meeting_start_ms: number;
          meeting_end_ms: number;
          duration_ms: number;
          sample_start: number;
          sample_end: number;
          first_sample_monotonic_ticks?: string;
          byte_size: number;
          checksum_algorithm?: string;
          checksum_sha256: string;
          storage_backend: string;
          storage_key: string;
          upload_state?: Database['public']['Enums']['chunk_upload_state'];
          verification_state?: Database['public']['Enums']['chunk_verification_state'];
          codec: string;
          container: string;
          sample_rate_hz: number;
          channels: number;
          encoder_delay_samples?: number;
          encoder_padding_samples?: number;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'recording_chunks_source_recording_workspace_fkey';
            columns: ['recording_source_id', 'recording_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'recording_sources';
            referencedColumns: ['id', 'recording_id', 'workspace_id'];
          },
          {
            foreignKeyName: 'recording_chunks_recording_meeting_workspace_fkey';
            columns: ['recording_id', 'meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'recordings';
            referencedColumns: ['id', 'meeting_id', 'workspace_id'];
          },
        ];
      };
      processing_jobs: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          recording_id: string;
          job_type: 'prepare_recording' | 'assemble_recording';
          generation: number;
          idempotency_key: string;
          status: Database['public']['Enums']['processing_job_status'];
          attempt: number;
          max_attempts: number;
          lease_owner: string | null;
          lease_expires_at: string | null;
          heartbeat_at: string | null;
          fencing_token: number;
          scheduled_at: string;
          started_at: string | null;
          completed_at: string | null;
          error_code: string | null;
          error_message: string | null;
          error_metadata: Json;
          payload: Json;
          result_metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'processing_jobs_recording_meeting_workspace_fkey';
            columns: ['recording_id', 'meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'recordings';
            referencedColumns: ['id', 'meeting_id', 'workspace_id'];
          },
          {
            foreignKeyName: 'processing_jobs_meeting_workspace_fkey';
            columns: ['meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'meetings';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      processing_events: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          recording_id: string | null;
          recording_source_id: string | null;
          recording_chunk_id: string | null;
          processing_job_id: string | null;
          sequence_no: number | null;
          event_type: string;
          actor_id: string | null;
          fencing_token: number | null;
          metadata: Json;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'processing_events_meeting_workspace_fkey';
            columns: ['meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'meetings';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      object_deletion_ledger: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          recording_id: string;
          recording_chunk_id: string | null;
          storage_backend: string;
          storage_key: string;
          expected_byte_size: number;
          expected_sha256: string;
          status: 'pending' | 'deleted' | 'reconciliation_required';
          attempt_count: number;
          last_error_code: string | null;
          last_error_message: string | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'object_deletion_ledger_meeting_workspace_fkey';
            columns: ['meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'meetings';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      transcription_assets: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          recording_id: string;
          asset_version: number;
          asset_role: 'canonical_transcription_input';
          status: Database['public']['Enums']['transcription_asset_status'];
          storage_backend: 'local' | 'memory' | 'r2' | 's3' | 'manifest_virtual';
          storage_key: string;
          container: 'wav' | 'ogg' | 'opus' | 'flac' | 'm4a';
          codec: string;
          sample_rate_hz: number;
          channels: number;
          byte_size: number;
          checksum_sha256: string;
          asset_duration_ms: number;
          canonical_duration_ms: number;
          active_capture_ms: number;
          timeline_map: Json;
          source_lineage: Json;
          preparation_metadata: Json;
          prepared_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'transcription_assets_meeting_workspace_fkey';
            columns: ['meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'meetings';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      transcription_runs: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          recording_id: string;
          transcription_asset_id: string;
          asset_version: number;
          run_number: number;
          provider: string;
          provider_model: string;
          provider_job_id: string | null;
          status: Database['public']['Enums']['transcription_run_status'];
          normalization_version: number;
          requested_languages: string[];
          detected_languages: string[];
          diarization_enabled: boolean;
          segment_count: number;
          quarantined_segment_count: number;
          speaker_count: number;
          word_count: number;
          confidence_avg: number | null;
          started_at: string | null;
          provider_completed_at: string | null;
          completed_at: string | null;
          error_code: string | null;
          error_message: string | null;
          failure_metadata: Json;
          provider_summary_metadata: Json;
          raw_provider_response: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'transcription_runs_meeting_workspace_fkey';
            columns: ['meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'meetings';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      meeting_participants: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          user_id: string | null;
          display_name: string;
          role_label: string | null;
          email: string | null;
          is_external: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'meeting_participants_meeting_workspace_fkey';
            columns: ['meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'meetings';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      meeting_speakers: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          transcription_run_id: string;
          provider_speaker_label: string;
          display_label: string;
          participant_id: string | null;
          mapped_by: string | null;
          mapped_at: string | null;
          segment_count: number;
          speaking_duration_ms: number;
          confidence_avg: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'meeting_speakers_meeting_workspace_fkey';
            columns: ['meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'meetings';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      transcript_segments: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          recording_id: string;
          transcription_run_id: string;
          transcription_asset_id: string;
          sequence_no: number;
          provider_segment_key: string;
          speaker_id: string;
          provider_speaker_label: string;
          start_ms: number;
          end_ms: number;
          duration_ms: number;
          asset_start_ms: number;
          asset_end_ms: number;
          source_recording_source_id: string | null;
          source_recording_chunk_id: string | null;
          source_sample_start: number | null;
          source_sample_end: number | null;
          text: string;
          language: 'uz' | 'ru' | 'en' | 'mixed' | 'unknown';
          confidence: number | null;
          word_count: number;
          words: Json;
          alignment_status: 'canonical' | 'quarantined';
          alignment_metadata: Json;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'transcript_segments_meeting_workspace_fkey';
            columns: ['meeting_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'meetings';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      embedding_runs: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          recording_id: string;
          transcription_run_id: string;
          analysis_run_id: string;
          run_number: number;
          status: Database['public']['Enums']['embedding_run_status'];
          provider: string;
          model_name: string;
          embedding_dimensions: number;
          chunking_version: string;
          chunk_count: number;
          token_usage_metadata: Json;
          error_code: string | null;
          error_message: string | null;
          requested_by: string | null;
          started_at: string | null;
          completed_at: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      knowledge_chunks: {
        Row: {
          id: string;
          workspace_id: string;
          company_id: string | null;
          project_id: string | null;
          meeting_id: string;
          embedding_run_id: string;
          transcription_run_id: string;
          analysis_run_id: string;
          sequence_no: number;
          chunk_kind: Database['public']['Enums']['knowledge_chunk_kind'];
          title_text: string | null;
          content_text: string;
          search_text: string;
          language_code: string | null;
          start_ms: number | null;
          end_ms: number | null;
          embedding: number[];
          metadata: Json;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      knowledge_chunk_transcript_sources: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          embedding_run_id: string;
          knowledge_chunk_id: string;
          transcription_run_id: string;
          transcript_segment_id: string;
          start_ms: number;
          end_ms: number;
          excerpt_text: string;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      knowledge_chunk_item_sources: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          embedding_run_id: string;
          knowledge_chunk_id: string;
          analysis_run_id: string;
          entity_type: Database['public']['Enums']['intelligence_entity_type'];
          entity_id: string;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      ask_ai_queries: {
        Row: {
          id: string;
          workspace_id: string;
          actor_id: string;
          scope_type: Database['public']['Enums']['ask_ai_scope_type'];
          company_id: string | null;
          project_id: string | null;
          question_text: string;
          answer_status: Database['public']['Enums']['ask_ai_answer_status'];
          answer_text: string;
          citations: Json;
          provider: string;
          model_name: string;
          token_usage_metadata: Json;
          latency_ms: number;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      telegram_link_tokens: {
        Row: {
          id: string;
          workspace_id: string;
          user_id: string;
          token_hash: string;
          preferred_language: string;
          notify_on_meeting_ready: boolean;
          expires_at: string;
          consumed_at: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      telegram_account_links: {
        Row: {
          id: string;
          workspace_id: string;
          user_id: string;
          telegram_user_id: string;
          telegram_chat_id: string;
          telegram_username: string | null;
          telegram_display_name: string | null;
          preferred_language: string;
          notify_on_meeting_ready: boolean;
          status: Database['public']['Enums']['telegram_account_link_status'];
          rate_limit_window_started_at: string;
          rate_limit_count: number;
          last_command_at: string | null;
          linked_at: string;
          unlinked_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      telegram_notification_deliveries: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          analysis_run_id: string;
          telegram_account_link_id: string;
          notification_kind: string;
          idempotency_key: string;
          status: Database['public']['Enums']['telegram_notification_delivery_status'];
          attempt_count: number;
          provider_message_id: string | null;
          deep_link_url: string;
          error_code: string | null;
          error_message: string | null;
          sent_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      workspace_automation_connectors: {
        Row: {
          id: string;
          workspace_id: string;
          connector_type: Database['public']['Enums']['automation_connector_type'];
          display_name: string;
          status: Database['public']['Enums']['automation_connector_status'];
          endpoint_url: string | null;
          config_metadata: Json;
          configured_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      business_automation_actions: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          analysis_run_id: string;
          connector_id: string | null;
          connector_type: Database['public']['Enums']['automation_connector_type'];
          action_type: Database['public']['Enums']['automation_action_type'];
          status: Database['public']['Enums']['automation_action_status'];
          idempotency_key: string;
          confirmation_token_hash: string;
          payload_preview: Json;
          payload_sha256: string;
          requested_by: string;
          confirmed_by: string | null;
          confirmed_at: string | null;
          executed_at: string | null;
          external_reference_id: string | null;
          external_url: string | null;
          attempt_count: number;
          error_code: string | null;
          error_message: string | null;
          response_metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      meeting_exports: {
        Row: {
          id: string;
          workspace_id: string;
          meeting_id: string;
          analysis_run_id: string | null;
          export_format: Database['public']['Enums']['meeting_export_format'];
          include_transcript: boolean;
          filename: string;
          byte_size: number;
          content_sha256: string;
          exported_by: string;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_workspace: {
        Args: { p_name: string; p_slug: string };
        Returns: string;
      };
      claim_next_processing_job: {
        Args: { p_worker_id: string; p_lease_seconds?: number; p_now?: string };
        Returns: Database['public']['Tables']['processing_jobs']['Row'][];
      };
      cosine_similarity: {
        Args: { a: number[]; b: number[] };
        Returns: number;
      };
    };
    Enums: {
      membership_role: 'owner' | 'admin' | 'member';
      membership_status: 'invited' | 'active' | 'suspended';
      meeting_status:
        | 'draft'
        | 'recording'
        | 'uploading'
        | 'processing'
        | 'ready_for_transcription'
        | 'transcribing'
        | 'normalizing_transcript'
        | 'transcript_ready'
        | 'transcription_failed'
        | 'ready_for_analysis'
        | 'analyzing'
        | 'normalizing_analysis'
        | 'analysis_ready'
        | 'analysis_failed'
        | 'indexing'
        | 'ready'
        | 'failed'
        | 'archived';
      meeting_processing_status:
        | 'idle'
        | 'recording'
        | 'uploading'
        | 'uploaded'
        | 'preparing'
        | 'ready_for_transcription'
        | 'transcribing'
        | 'normalizing_transcript'
        | 'transcript_ready'
        | 'transcription_failed'
        | 'ready_for_analysis'
        | 'analyzing'
        | 'normalizing_analysis'
        | 'analysis_ready'
        | 'analysis_failed'
        | 'indexing'
        | 'ready'
        | 'failed';
      recording_status:
        | 'registered'
        | 'recording'
        | 'paused'
        | 'uploading'
        | 'finalizing'
        | 'finalized'
        | 'failed'
        | 'interrupted'
        | 'deleted';
      recording_source_kind: 'microphone' | 'system_audio' | 'mixed_rendered';
      recording_source_role: 'original' | 'derived';
      chunk_upload_state:
        | 'pending'
        | 'authorizing'
        | 'uploading'
        | 'uploaded'
        | 'verifying'
        | 'verified'
        | 'failed_retryable'
        | 'failed_terminal';
      chunk_verification_state: 'pending' | 'verifying' | 'verified' | 'rejected';
      processing_job_status:
        'queued' | 'running' | 'retryable_failed' | 'succeeded' | 'dead_lettered' | 'cancelled';
      transcription_asset_status: 'preparing' | 'ready' | 'failed' | 'deleted';
      transcription_run_status:
        'queued' | 'running' | 'normalizing' | 'completed' | 'failed' | 'superseded';
      analysis_run_status:
        'queued' | 'running' | 'normalizing' | 'completed' | 'failed' | 'superseded';
      decision_status: 'proposed' | 'tentative' | 'confirmed' | 'rejected' | 'superseded';
      action_item_status: 'open' | 'in_progress' | 'done' | 'cancelled';
      fact_category:
        | 'budget'
        | 'metric'
        | 'timeline'
        | 'team'
        | 'commercial'
        | 'technical'
        | 'legal'
        | 'operations'
        | 'general';
      question_status: 'open' | 'answered' | 'deferred';
      idea_status: 'captured' | 'exploring' | 'accepted' | 'parked' | 'rejected';
      objection_status: 'open' | 'addressed' | 'mitigated' | 'unresolved';
      commitment_status: 'pending' | 'kept' | 'at_risk' | 'broken';
      risk_severity: 'low' | 'medium' | 'high' | 'critical';
      risk_status: 'open' | 'mitigating' | 'resolved' | 'accepted';
      intelligence_entity_type:
        | 'summary_claim'
        | 'topic'
        | 'decision'
        | 'action_item'
        | 'fact'
        | 'question'
        | 'idea'
        | 'objection'
        | 'commitment'
        | 'risk';
      embedding_run_status: 'queued' | 'running' | 'completed' | 'failed' | 'superseded';
      knowledge_chunk_kind: 'transcript_window' | 'summary' | 'decision' | 'action_item' | 'fact';
      ask_ai_scope_type: 'workspace' | 'company' | 'project';
      ask_ai_answer_status: 'answered' | 'insufficient_evidence' | 'no_indexed_knowledge';
      telegram_account_link_status: 'active' | 'unlinked' | 'suspended';
      telegram_notification_delivery_status: 'pending' | 'sent' | 'failed' | 'skipped';
      automation_connector_type: 'google_calendar' | 'google_docs' | 'amocrm' | 'n8n_webhook';
      automation_connector_status: 'enabled' | 'disabled';
      automation_action_type:
        | 'create_calendar_followup'
        | 'export_google_doc'
        | 'sync_crm_deal_note'
        | 'trigger_n8n_workflow';
      automation_action_status:
        'pending_confirmation' | 'confirmed' | 'executing' | 'succeeded' | 'failed' | 'cancelled';
      meeting_export_format: 'md' | 'txt' | 'csv' | 'json' | 'pdf';
    };
    CompositeTypes: Record<string, never>;
  };
};
