/**
 * Stable demo identifiers.
 *
 * Every fixture cross-reference goes through one of these constants instead of a bare string, which is what
 * makes "if a decision cites `seg_42`, that segment must exist" a compile-time habit rather than a hope.
 */

export const DEMO_WORKSPACE_ID = 'ws_suhbat_demo';

export const person = {
  elmurod: 'person_elmurod',
  akmal: 'person_akmal',
  aziz: 'person_aziz',
  dilshod: 'person_dilshod',
  nigora: 'person_nigora',
  rustam: 'person_rustam',
  alexey: 'person_alexey',
  malika: 'person_malika',
} as const;

/** The demo "signed-in user": used by `Tasks → Mine` and the account control. */
export const DEMO_CURRENT_PERSON_ID = person.akmal;

export const company = {
  foodera: 'company_foodera',
  nomad: 'company_nomad_education',
  chirchik: 'company_chirchik_textile',
} as const;

export const project = {
  fooderaGrowth: 'project_foodera_growth_q4',
  fooderaCrm: 'project_foodera_crm',
  nomadIntake: 'project_nomad_autumn_intake',
  chirchikExport: 'project_chirchik_export',
} as const;

export const meetingType = {
  marketing: 'mtype_marketing',
  sales: 'mtype_sales',
  projectSync: 'mtype_project_sync',
  board: 'mtype_board',
  customerCall: 'mtype_customer_call',
  oneOnOne: 'mtype_one_on_one',
  planning: 'mtype_planning',
  retro: 'mtype_retro',
} as const;

export const meeting = {
  fooderaMarketing: 'meeting_foodera_marketing_strategy',
  fooderaCrmSync: 'meeting_foodera_crm_rollout_sync',
  nomadPipeline: 'meeting_nomad_q3_pipeline',
  chirchikExport: 'meeting_chirchik_export_review',
  boardQ4: 'meeting_suhbat_board_q4_planning',
  fooderaCreative: 'meeting_foodera_creative_review',
} as const;

export const topic = {
  marketing: 'topic_foodera_marketing',
  metaAds: 'topic_foodera_meta_ads',
  creatives: 'topic_foodera_creatives',
  audience: 'topic_foodera_audience',
  sales: 'topic_foodera_sales',
  leadQuality: 'topic_foodera_lead_quality',
  conversion: 'topic_foodera_conversion',
  crm: 'topic_foodera_crm',
  commercial: 'topic_foodera_commercial',
  budget: 'topic_foodera_budget',
  proposal: 'topic_foodera_proposal',
  nextSteps: 'topic_foodera_next_steps',
  reactivation: 'topic_foodera_reactivation',
} as const;
