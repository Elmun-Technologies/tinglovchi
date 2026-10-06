import type { FactCategory } from '../domain';
import type { LineRange, MeetingKey } from './ranges';
import { company, person, topic } from './ids';

/**
 * Analysis artifacts the product extracts from a meeting. Each one cites the transcript lines it came from,
 * so `Evidence → transcript` navigation is real in demo mode and the integrity test can prove it.
 */

export type DemoDecisionSeed = {
  id: string;
  meetingKey: MeetingKey;
  topicId: string | null;
  title: string;
  description: string;
  status: 'proposed' | 'tentative' | 'confirmed' | 'rejected' | 'superseded';
  participantPersonIds: string[];
  decidedOn: string;
  supersededByDecisionId?: string;
  lines: LineRange;
};

export type DemoTaskSeed = {
  id: string;
  meetingKey: MeetingKey;
  topicId: string | null;
  title: string;
  detail?: string;
  ownerPersonId: string | null;
  dueDate: string | null;
  status: 'open' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
  priority: 'low' | 'normal' | 'high';
  lines: LineRange;
};

export type DemoFactSeed = {
  id: string;
  meetingKey: MeetingKey;
  category: FactCategory;
  label: string;
  value: string;
  unit?: string;
  speakerPersonId: string | null;
  lines: LineRange;
};

export type DemoQuestionSeed = {
  id: string;
  meetingKey: MeetingKey;
  topicId: string | null;
  text: string;
  askedByPersonId: string | null;
  status: 'open' | 'answered' | 'deferred';
  lines: LineRange;
  resolution?: {
    answer: string;
    answeredOn: string;
    answeredByPersonId: string | null;
    lines: LineRange;
  };
};

export type DemoIdeaSeed = {
  id: string;
  meetingKey: MeetingKey;
  topicId: string | null;
  text: string;
  proposedByPersonId: string;
  status: 'new' | 'considering' | 'adopted' | 'dropped';
  lines: LineRange;
};

export type DemoCommitmentSeed = {
  id: string;
  meetingKey: MeetingKey;
  text: string;
  byPersonId: string;
  dueDate: string | null;
  status: 'pending' | 'met' | 'missed';
  lines: LineRange;
};

export const demoDecisions: DemoDecisionSeed[] = [
  {
    id: 'dec_foodera_budget_held',
    meetingKey: 'fooderaMarketing',
    topicId: topic.budget,
    title: 'October media budget stays at $5,000',
    description:
      'No increase and no audience expansion this month. $800 of the existing budget is carved out for a Google PMax test to reduce Meta dependence.',
    status: 'confirmed',
    participantPersonIds: [person.elmurod, person.dilshod, person.akmal],
    decidedOn: '2026-10-06',
    lines: [28, 30],
  },
  {
    id: 'dec_foodera_qualified_definition',
    meetingKey: 'fooderaMarketing',
    topicId: topic.proposal,
    title: 'Qualified lead = 3+ couriers, aggregator work, 300+ orders per month',
    description:
      'All three conditions become required CRM fields, so the qualification rate is measurable instead of argued. The order-volume threshold was lowered from 500 to 300 after Malika pointed out that small locations carry better margin.',
    status: 'confirmed',
    participantPersonIds: [person.rustam, person.nigora, person.dilshod, person.elmurod],
    decidedOn: '2026-10-06',
    lines: [36, 39],
  },
  {
    id: 'dec_foodera_form_sla',
    meetingKey: 'fooderaMarketing',
    topicId: topic.conversion,
    title: 'Form cut to three fields plus two qualification questions, with a 24-hour call SLA',
    description:
      'The third qualification question (average ticket) is deferred to the next test because the client team expected blank answers. SLA is measured from lead capture, business hours only.',
    status: 'confirmed',
    participantPersonIds: [person.akmal, person.dilshod, person.elmurod],
    decidedOn: '2026-10-06',
    lines: [9, 13],
  },
  {
    id: 'dec_foodera_creative_pipeline',
    meetingKey: 'fooderaMarketing',
    topicId: topic.creatives,
    title: 'In-house creative pipeline: 12 UGC + 4 studio pieces per month',
    description:
      'Adopted because frequency hit 4.2 over 28 days and only nine creatives were live, which cannot support a 10-day rotation.',
    status: 'confirmed',
    participantPersonIds: [person.elmurod, person.nigora, person.aziz],
    decidedOn: '2026-10-06',
    lines: [17, 19],
  },
  {
    id: 'dec_foodera_advantage_off',
    meetingKey: 'fooderaMarketing',
    topicId: topic.creatives,
    title: 'Keep Advantage+ placements off for two weeks',
    description:
      'Directional at the end of the meeting: Advantage+ skewed the audience younger and younger users do not order. Held as tentative until the CPL-by-creative-type model lands on Monday.',
    status: 'tentative',
    participantPersonIds: [person.akmal, person.aziz],
    decidedOn: '2026-10-06',
    lines: [15, 16],
  },
  {
    id: 'dec_foodera_crm_simplify_next_sprint',
    meetingKey: 'fooderaMarketing',
    topicId: topic.crm,
    title: 'CRM stage simplification moves to the next sprint',
    description:
      'Field names and mandatory flags are written down now; the actual funnel change waits because the six-person sales team cannot absorb both changes at once.',
    status: 'confirmed',
    participantPersonIds: [person.rustam, person.dilshod, person.elmurod],
    decidedOn: '2026-10-06',
    lines: [21, 23],
  },
  {
    id: 'dec_crm_stages_six',
    meetingKey: 'fooderaCrmSync',
    topicId: 'topic_crm_stages',
    title: 'CRM funnel reduced to six stages',
    description:
      'New, Qualified, Demo, Proposal, Won, Lost. Eleven stages existed; only three were used in practice.',
    status: 'confirmed',
    participantPersonIds: [person.rustam, person.akmal],
    decidedOn: '2026-10-05',
    lines: [0, 2],
  },
  {
    id: 'dec_crm_ui_language',
    meetingKey: 'fooderaCrmSync',
    topicId: 'topic_crm_ux',
    title: 'Keep the Russian CRM interface, relabel fields in Uzbek',
    description:
      'Switching the whole interface was rejected as a bigger change than the problem it solves; field labels are the part managers actually read.',
    status: 'confirmed',
    participantPersonIds: [person.nigora, person.akmal, person.dilshod],
    decidedOn: '2026-10-05',
    lines: [9, 11],
  },
  {
    id: 'dec_nomad_saturday_slots',
    meetingKey: 'nomadPipeline',
    topicId: 'topic_nomad_offer',
    title: 'Add three Saturday slots for the autumn intake',
    description:
      'Approved without waiting for the instalment calculation, because schedule — not price — was the primary blocker named by sales.',
    status: 'confirmed',
    participantPersonIds: [person.alexey, person.akmal],
    decidedOn: '2026-10-02',
    lines: [6, 8],
  },
  {
    id: 'dec_nomad_instalments',
    meetingKey: 'nomadPipeline',
    topicId: 'topic_nomad_offer',
    title: 'Three-payment instalment plan',
    description:
      'Proposed in the meeting and explicitly held: no commitment until unit economics of the instalment are calculated.',
    status: 'proposed',
    participantPersonIds: [person.alexey, person.aziz],
    decidedOn: '2026-10-02',
    lines: [7, 7],
  },
  {
    id: 'dec_chirchik_price_640',
    meetingKey: 'chirchikExport',
    topicId: 'topic_chirchik_commercial',
    title: 'Price at $6.40 per metre delivered to Almaty',
    description:
      'Opening position from the seller; the buyer asked for $6.05 at 12,000 m and the meeting moved past it.',
    status: 'superseded',
    participantPersonIds: [person.malika],
    decidedOn: '2026-09-28',
    supersededByDecisionId: 'dec_chirchik_price_620',
    lines: [3, 3],
  },
  {
    id: 'dec_chirchik_price_620',
    meetingKey: 'chirchikExport',
    topicId: 'topic_chirchik_commercial',
    title: '$6.20 per metre at 15,000 m, 30% prepayment',
    description:
      'Balance due 10 days after delivery. Prepayment is the condition for starting production, per Malika.',
    status: 'confirmed',
    participantPersonIds: [person.akmal, person.malika, person.elmurod],
    decidedOn: '2026-09-28',
    lines: [4, 6],
  },
  {
    id: 'dec_chirchik_no_cert_decision',
    meetingKey: 'chirchikExport',
    topicId: 'topic_chirchik_open_items',
    title: 'Who pays certification — deliberately not decided',
    description:
      'Recorded as an explicit non-decision: the team refused to answer without modelling the 1.8M UZN per-party cost into the price. Kept so the meeting does not look more conclusive than it was.',
    status: 'rejected',
    participantPersonIds: [person.elmurod, person.malika],
    decidedOn: '2026-09-28',
    lines: [7, 9],
  },
  {
    id: 'dec_board_enterprise_deferred',
    meetingKey: 'boardQ4',
    topicId: 'topic_board_focus',
    title: 'Enterprise features postponed to next year',
    description:
      'Q4 stays focused on small teams: 62% weekly team retention and 11 meetings per workspace are the signals behind the call.',
    status: 'confirmed',
    participantPersonIds: [person.elmurod, person.akmal],
    decidedOn: '2026-09-21',
    lines: [2, 3],
  },
  {
    id: 'dec_board_pricing_all',
    meetingKey: 'boardQ4',
    topicId: 'topic_board_hiring',
    title: 'Move all customers to $45 per seat',
    description:
      'Rejected as a blanket change: Aziz warned pilots could leave over a price rise mid-engagement.',
    status: 'superseded',
    participantPersonIds: [person.akmal, person.aziz],
    decidedOn: '2026-09-21',
    supersededByDecisionId: 'dec_board_pricing_new_only',
    lines: [7, 8],
  },
  {
    id: 'dec_board_pricing_new_only',
    meetingKey: 'boardQ4',
    topicId: 'topic_board_hiring',
    title: '$45 per seat for new customers only',
    description: 'Existing pilots keep their agreed price for the life of the pilot.',
    status: 'confirmed',
    participantPersonIds: [person.elmurod, person.aziz, person.akmal],
    decidedOn: '2026-09-21',
    lines: [9, 9],
  },
  {
    id: 'dec_creative_no_promo_code',
    meetingKey: 'fooderaCreative',
    topicId: 'topic_creative_launch',
    title: 'Launch without promo-code variants',
    description:
      'The current promo code is expired, so variants that mention it are excluded from this batch rather than re-shooting the copy.',
    status: 'confirmed',
    participantPersonIds: [person.akmal, person.nigora],
    decidedOn: '2026-10-06',
    lines: [3, 4],
  },
];

export const demoTasks: DemoTaskSeed[] = [
  {
    id: 'task_foodera_form',
    meetingKey: 'fooderaMarketing',
    topicId: topic.conversion,
    title: 'Ship the shortened lead form (3 fields + 2 qualification questions)',
    detail: 'Remove address and comment; add courier count and aggregator question.',
    ownerPersonId: person.aziz,
    dueDate: '2026-10-09',
    status: 'open',
    priority: 'high',
    lines: [9, 13],
  },
  {
    id: 'task_foodera_cpl_model',
    meetingKey: 'fooderaMarketing',
    topicId: topic.creatives,
    title: 'Model CPL and revenue per lead by creative type',
    detail: 'Use amoCRM revenue data from 1 October; state that attribution is unreconciled.',
    ownerPersonId: person.aziz,
    dueDate: '2026-10-12',
    status: 'open',
    priority: 'normal',
    lines: [19, 20],
  },
  {
    id: 'task_foodera_ugc_rewrites',
    meetingKey: 'fooderaMarketing',
    topicId: topic.creatives,
    title: 'Rewrite six UGC scripts against September numbers',
    ownerPersonId: person.akmal,
    dueDate: '2026-10-15',
    status: 'open',
    priority: 'normal',
    lines: [40, 40],
  },
  {
    id: 'task_foodera_sla_rule',
    meetingKey: 'fooderaMarketing',
    topicId: topic.conversion,
    title: 'Write the 24-hour call SLA into the sales rules',
    detail: 'Business hours only; measured from lead capture time.',
    ownerPersonId: person.akmal,
    dueDate: '2026-10-08',
    status: 'in_progress',
    priority: 'high',
    lines: [12, 12],
  },
  {
    id: 'task_foodera_owner_report',
    meetingKey: 'fooderaMarketing',
    topicId: topic.nextSteps,
    title: 'Owner report with revenue figures marked provisional',
    detail: 'Include the note that attribution sources are not reconciled yet.',
    ownerPersonId: person.dilshod,
    dueDate: '2026-10-10',
    status: 'open',
    priority: 'normal',
    lines: [50, 51],
  },
  {
    id: 'task_foodera_dashboard_access',
    meetingKey: 'fooderaMarketing',
    topicId: topic.nextSteps,
    title: 'Give Dilshod and Nigora read-only access to the lead-score dashboard',
    ownerPersonId: person.akmal,
    dueDate: '2026-10-13',
    status: 'open',
    priority: 'normal',
    lines: [56, 57],
  },
  {
    id: 'task_crm_field_template',
    meetingKey: 'fooderaCrmSync',
    topicId: 'topic_crm_stages',
    title: 'Prepare the CRM field template (CSV) and agree it with the client',
    ownerPersonId: person.rustam,
    dueDate: '2026-10-05',
    status: 'open',
    priority: 'high',
    lines: [12, 12],
  },
  {
    id: 'task_crm_dedup_rule',
    meetingKey: 'fooderaCrmSync',
    topicId: 'topic_crm_automation',
    title: 'Write the legacy-lead cleanup rule',
    detail: 'Deduplicate by phone and company name, keep the latest active deal.',
    ownerPersonId: person.aziz,
    dueDate: '2026-10-14',
    status: 'open',
    priority: 'normal',
    lines: [6, 8],
  },
  {
    id: 'task_crm_source_metric',
    meetingKey: 'fooderaCrmSync',
    topicId: 'topic_crm_automation',
    title: 'Track the share of leads with a filled source field (target 95%)',
    ownerPersonId: person.aziz,
    dueDate: '2026-10-31',
    status: 'open',
    priority: 'low',
    lines: [13, 13],
  },
  {
    id: 'task_nomad_hourly_metrics',
    meetingKey: 'nomadPipeline',
    topicId: 'topic_nomad_funnel',
    title: 'Measure reply rate by hour and payment-step completion',
    ownerPersonId: person.aziz,
    dueDate: '2026-10-07',
    status: 'open',
    priority: 'normal',
    lines: [11, 11],
  },
  {
    id: 'task_nomad_teacher_profiles',
    meetingKey: 'nomadPipeline',
    topicId: 'topic_nomad_offer',
    title: 'Put teacher profiles on the landing page',
    ownerPersonId: person.akmal,
    dueDate: '2026-10-09',
    status: 'open',
    priority: 'normal',
    lines: [12, 13],
  },
  {
    id: 'task_nomad_instalment_model',
    meetingKey: 'nomadPipeline',
    topicId: 'topic_nomad_offer',
    title: 'Calculate instalment unit economics before any commitment',
    ownerPersonId: null,
    dueDate: '2026-10-16',
    status: 'blocked',
    priority: 'normal',
    lines: [7, 7],
  },
  {
    id: 'task_chirchik_logistics_quote',
    meetingKey: 'chirchikExport',
    topicId: 'topic_chirchik_open_items',
    title: 'Collect the logistics quote for the Almaty shipment',
    ownerPersonId: person.aziz,
    dueDate: '2026-10-02',
    status: 'completed',
    priority: 'high',
    lines: [10, 10],
  },
  {
    id: 'task_chirchik_proposal_template',
    meetingKey: 'chirchikExport',
    topicId: 'topic_chirchik_open_items',
    title: 'Build a reusable commercial-proposal template',
    detail: 'Currently written by hand for every buyer.',
    ownerPersonId: person.akmal,
    dueDate: '2026-10-19',
    status: 'open',
    priority: 'normal',
    lines: [11, 11],
  },
  {
    id: 'task_board_roadmap_doc',
    meetingKey: 'boardQ4',
    topicId: 'topic_board_focus',
    title: 'Publish the Q4 roadmap document',
    ownerPersonId: person.akmal,
    dueDate: '2026-10-09',
    status: 'open',
    priority: 'high',
    lines: [11, 11],
  },
  {
    id: 'task_board_deck',
    meetingKey: 'boardQ4',
    topicId: 'topic_board_hiring',
    title: 'Assemble the board deck (20 November)',
    detail: 'Malika collects, Elmurod edits.',
    ownerPersonId: person.malika,
    dueDate: '2026-11-20',
    status: 'open',
    priority: 'normal',
    lines: [10, 10],
  },
  {
    id: 'task_creative_brief_update',
    meetingKey: 'fooderaCreative',
    topicId: 'topic_creative_rotation',
    title: 'Add CPL (not views) as the success metric in the creative brief',
    ownerPersonId: person.akmal,
    dueDate: '2026-10-12',
    status: 'open',
    priority: 'normal',
    lines: [11, 11],
  },
];

export const demoFacts: DemoFactSeed[] = [
  {
    id: 'fact_foodera_qualification_rate',
    meetingKey: 'fooderaMarketing',
    category: 'metric',
    label: 'Qualified-lead share, September',
    value: '57',
    unit: '%',
    speakerPersonId: person.dilshod,
    lines: [1, 1],
  },
  {
    id: 'fact_foodera_qualification_target',
    meetingKey: 'fooderaMarketing',
    category: 'target',
    label: 'Qualified-lead share target',
    value: '70+',
    unit: '%',
    speakerPersonId: person.dilshod,
    lines: [1, 1],
  },
  {
    id: 'fact_foodera_budget',
    meetingKey: 'fooderaMarketing',
    category: 'budget',
    label: 'Monthly media budget',
    value: '5,000',
    unit: 'USD',
    speakerPersonId: person.elmurod,
    lines: [28, 28],
  },
  {
    id: 'fact_foodera_leads',
    meetingKey: 'fooderaMarketing',
    category: 'metric',
    label: 'Leads in September',
    value: '4,120',
    speakerPersonId: person.dilshod,
    lines: [1, 1],
  },
  {
    id: 'fact_foodera_form_drop',
    meetingKey: 'fooderaMarketing',
    category: 'metric',
    label: 'Loss between form submit and manager call',
    value: '41',
    unit: '%',
    speakerPersonId: person.aziz,
    lines: [6, 8],
  },
  {
    id: 'fact_foodera_frequency',
    meetingKey: 'fooderaMarketing',
    category: 'metric',
    label: 'Ad frequency over 28 days',
    value: '4.2',
    speakerPersonId: person.aziz,
    lines: [17, 17],
  },
  {
    id: 'fact_foodera_ctr_split',
    meetingKey: 'fooderaMarketing',
    category: 'metric',
    label: 'CTR: UGC vs studio creatives',
    value: '2.4% vs 1.6%',
    speakerPersonId: person.aziz,
    lines: [14, 14],
  },
  {
    id: 'fact_foodera_team_size',
    meetingKey: 'fooderaMarketing',
    category: 'team',
    label: 'Sales team handling leads',
    value: '6',
    unit: 'managers',
    speakerPersonId: person.nigora,
    lines: [11, 11],
  },
  {
    id: 'fact_foodera_attribution_gap',
    meetingKey: 'fooderaMarketing',
    category: 'constraint',
    label: 'GA4 vs amoCRM revenue disagreement',
    value: '21',
    unit: '%',
    speakerPersonId: person.aziz,
    lines: [30, 30],
  },
  {
    id: 'fact_foodera_dormant_clients',
    meetingKey: 'fooderaMarketing',
    category: 'metric',
    label: 'Dormant customers available for reactivation',
    value: '12,400',
    speakerPersonId: person.aziz,
    lines: [42, 42],
  },
  {
    id: 'fact_foodera_cpl_center',
    meetingKey: 'fooderaMarketing',
    category: 'metric',
    label: 'CPL by district (center / Yunusabad / Chilonzor)',
    value: '29,000 / 34,000 / 41,000',
    unit: 'UZS',
    speakerPersonId: person.aziz,
    lines: [24, 25],
  },
  {
    id: 'fact_foodera_targeting',
    meetingKey: 'fooderaMarketing',
    category: 'preference',
    label: 'Current geo and age targeting',
    value: '3–5 km radius, 18–45',
    speakerPersonId: person.akmal,
    lines: [24, 24],
  },
  {
    id: 'fact_crm_stages_before',
    meetingKey: 'fooderaCrmSync',
    category: 'tooling',
    label: 'CRM stages today / actually used',
    value: '11 / 3',
    speakerPersonId: person.rustam,
    lines: [0, 0],
  },
  {
    id: 'fact_crm_legacy_leads',
    meetingKey: 'fooderaCrmSync',
    category: 'metric',
    label: 'Legacy leads to migrate',
    value: '8,600',
    speakerPersonId: person.aziz,
    lines: [6, 6],
  },
  {
    id: 'fact_nomad_leads',
    meetingKey: 'nomadPipeline',
    category: 'metric',
    label: 'Leads in funnel / orders needed',
    value: '610 / 240',
    speakerPersonId: person.alexey,
    lines: [0, 0],
  },
  {
    id: 'fact_nomad_conversion',
    meetingKey: 'nomadPipeline',
    category: 'metric',
    label: 'Enrolment conversion rate',
    value: '18 → 26',
    unit: '%',
    speakerPersonId: person.akmal,
    lines: [1, 1],
  },
  {
    id: 'fact_nomad_abandon',
    meetingKey: 'nomadPipeline',
    category: 'metric',
    label: 'Applications abandoned at payment',
    value: '34',
    unit: '%',
    speakerPersonId: person.aziz,
    lines: [3, 3],
  },
  {
    id: 'fact_chirchik_price',
    meetingKey: 'chirchikExport',
    category: 'budget',
    label: 'Agreed price per metre',
    value: '6.20',
    unit: 'USD',
    speakerPersonId: person.elmurod,
    lines: [4, 4],
  },
  {
    id: 'fact_chirchik_cert_cost',
    meetingKey: 'chirchikExport',
    category: 'budget',
    label: 'Certification cost per party',
    value: '1.8',
    unit: 'M UZS',
    speakerPersonId: person.malika,
    lines: [8, 8],
  },
  {
    id: 'fact_board_retention',
    meetingKey: 'boardQ4',
    category: 'metric',
    label: 'Weekly team retention / meetings per workspace',
    value: '62% / 11',
    speakerPersonId: person.aziz,
    lines: [2, 2],
  },
  {
    id: 'fact_board_arr_target',
    meetingKey: 'boardQ4',
    category: 'target',
    label: 'Q4 ARR target',
    value: '180',
    unit: 'K USD',
    speakerPersonId: person.elmurod,
    lines: [0, 0],
  },
  {
    id: 'fact_board_hiring_cycle',
    meetingKey: 'boardQ4',
    category: 'timeline',
    label: 'Hiring cycle length',
    value: '8',
    unit: 'weeks',
    speakerPersonId: person.aziz,
    lines: [5, 5],
  },
  {
    id: 'fact_creative_production_budget',
    meetingKey: 'fooderaCreative',
    category: 'budget',
    label: 'Production budget left this month',
    value: '900',
    unit: 'USD',
    speakerPersonId: person.dilshod,
    lines: [15, 15],
  },
  {
    id: 'fact_creative_ctr_floor',
    meetingKey: 'fooderaCreative',
    category: 'target',
    label: 'Acceptance bar for the new batch',
    value: 'CTR > 2.2%, frequency < 3',
    speakerPersonId: person.aziz,
    lines: [5, 5],
  },
  {
    id: 'fact_creative_uzbek_share',
    meetingKey: 'fooderaCreative',
    category: 'preference',
    label: 'Audience that reads rather than listens',
    value: '60',
    unit: '%',
    speakerPersonId: person.dilshod,
    lines: [2, 2],
  },
];

export const demoQuestions: DemoQuestionSeed[] = [
  {
    id: 'q_foodera_attribution',
    meetingKey: 'fooderaMarketing',
    topicId: topic.proposal,
    text: 'Which system is the source of truth for revenue while GA4 and amoCRM disagree by 21%?',
    askedByPersonId: person.dilshod,
    status: 'open',
    lines: [30, 32],
  },
  {
    id: 'q_foodera_volume_risk',
    meetingKey: 'fooderaMarketing',
    topicId: topic.audience,
    text: 'How much order volume are we willing to lose if the radius is narrowed?',
    askedByPersonId: person.dilshod,
    status: 'answered',
    lines: [26, 27],
    resolution: {
      answer:
        'Not narrowed this month. Quality work goes first, and the owner’s volume requirement is why the budget stays where it is.',
      answeredOn: '2026-10-06',
      answeredByPersonId: person.elmurod,
      lines: [28, 28],
    },
  },
  {
    id: 'q_crm_mobile_capacity',
    meetingKey: 'fooderaCrmSync',
    topicId: 'topic_crm_ux',
    text: 'Will managers fill the required fields without a usable mobile flow?',
    askedByPersonId: person.dilshod,
    status: 'open',
    lines: [9, 11],
  },
  {
    id: 'q_nomad_speaker',
    meetingKey: 'nomadPipeline',
    topicId: null,
    text: 'Who is the third voice in the recording (Speaker C)?',
    askedByPersonId: person.malika,
    status: 'open',
    lines: [4, 5],
  },
  {
    id: 'q_chirchik_certification',
    meetingKey: 'chirchikExport',
    topicId: 'topic_chirchik_open_items',
    text: 'Who pays for certification on each party — us or the buyer?',
    askedByPersonId: person.aziz,
    status: 'deferred',
    lines: [7, 9],
  },
  {
    id: 'q_creative_rotation_count',
    meetingKey: 'fooderaCreative',
    topicId: 'topic_creative_rotation',
    text: 'How many creatives count as a sufficient rotation set — 6 or 12?',
    askedByPersonId: person.dilshod,
    status: 'answered',
    lines: [6, 9],
    resolution: {
      answer:
        'Twelve, because a 10-day rotation needs that many live at once; measurement is CPL, not views.',
      answeredOn: '2026-10-06',
      answeredByPersonId: person.elmurod,
      lines: [9, 11],
    },
  },
];

export const demoIdeas: DemoIdeaSeed[] = [
  {
    id: 'idea_foodera_whatsapp',
    meetingKey: 'fooderaMarketing',
    topicId: topic.reactivation,
    text: 'WhatsApp re-engagement flow for dormant customers — cheaper than buying new leads.',
    proposedByPersonId: person.nigora,
    status: 'considering',
    lines: [41, 43],
  },
  {
    id: 'idea_foodera_split_ad_groups',
    meetingKey: 'fooderaMarketing',
    topicId: topic.audience,
    text: 'Split Yunusabad and Chilonzor into separate ad groups instead of changing the radius.',
    proposedByPersonId: person.akmal,
    status: 'new',
    lines: [24, 25],
  },
  {
    id: 'idea_foodera_ugc_courier',
    meetingKey: 'fooderaCreative',
    topicId: 'topic_creative_launch',
    text: 'Lead the batch with courier-on-screen variants; they hold the highest watch-through.',
    proposedByPersonId: person.malika,
    status: 'adopted',
    lines: [1, 1],
  },
  {
    id: 'idea_nomad_night_ads_off',
    meetingKey: 'nomadPipeline',
    topicId: 'topic_nomad_offer',
    text: 'Stop serving ads after 22:00 instead of buying more night leads.',
    proposedByPersonId: person.alexey,
    status: 'adopted',
    lines: [9, 10],
  },
  {
    id: 'idea_chirchik_proposal_template',
    meetingKey: 'chirchikExport',
    topicId: 'topic_chirchik_open_items',
    text: 'A proposal template that fills itself from meeting facts would remove the manual drafting step.',
    proposedByPersonId: person.malika,
    status: 'new',
    lines: [11, 11],
  },
];

export const demoCommitments: DemoCommitmentSeed[] = [
  {
    id: 'commit_rustam_integration',
    meetingKey: 'fooderaMarketing',
    text: 'Rustam connects the form to amoCRM — two working days once API access is granted.',
    byPersonId: person.rustam,
    dueDate: '2026-10-09',
    status: 'pending',
    lines: [44, 46],
  },
  {
    id: 'commit_dilshod_access',
    meetingKey: 'fooderaMarketing',
    text: 'Dilshod grants Rustam the CRM access needed for the integration.',
    byPersonId: person.dilshod,
    dueDate: '2026-10-09',
    status: 'pending',
    lines: [46, 46],
  },
  {
    id: 'commit_aziz_deadlines',
    meetingKey: 'fooderaMarketing',
    text: 'Aziz keeps the consolidated date list: form 9 Oct, creatives 15 Oct, integration 9 Oct, report 10 Oct.',
    byPersonId: person.aziz,
    dueDate: '2026-10-09',
    status: 'met',
    lines: [55, 55],
  },
  {
    id: 'commit_malika_creative_review',
    meetingKey: 'fooderaMarketing',
    text: 'Malika reviews creatives only — filming stays on the client side.',
    byPersonId: person.malika,
    dueDate: null,
    status: 'pending',
    lines: [53, 54],
  },
  {
    id: 'commit_crm_csv_monday',
    meetingKey: 'fooderaCrmSync',
    text: 'Rustam delivers the field-template CSV by Monday for Akmal to agree with Dilshod.',
    byPersonId: person.rustam,
    dueDate: '2026-10-05',
    status: 'missed',
    lines: [12, 12],
  },
  {
    id: 'commit_board_deck',
    meetingKey: 'boardQ4',
    text: 'Malika assembles the board deck for 20 November; Elmurod edits it.',
    byPersonId: person.malika,
    dueDate: '2026-11-20',
    status: 'pending',
    lines: [10, 10],
  },
];

/** Company intelligence: derived by the builder from the fixtures above, with these framing statements. */
export const demoIntelligenceNotes: Record<
  string,
  { goals: string[]; painPoints: string[]; decisionMakers: string[]; objections: string[] }
> = {
  [company.foodera]: {
    goals: [
      'Raise qualified-lead share from 57% toward 70%+ without increasing media spend.',
      'Keep order volume while tightening targeting — volume is an owner-level requirement.',
    ],
    painPoints: [
      'Four-step lead form loses 41% of leads before a manager calls.',
      'Six-person sales team cannot absorb funnel and field changes at the same time.',
      'Revenue attribution differs by 21% between GA4 and amoCRM.',
    ],
    decisionMakers: [
      'Dilshod Karimov — marketing manager, owns the weekly report to the owner.',
      'Nigora Abdullaeva — account manager, owns call capacity and field load.',
    ],
    objections: [
      '“Shorter form means fewer leads” — no guarantee quality rises (Dilshod, 6 Oct).',
      'Manual lead transfer into CRM will kill the flow without integration (Dilshod, 6 Oct).',
      'The average-ticket question will be left blank by clients (Nigora, 6 Oct).',
    ],
  },
  [company.nomad]: {
    goals: [
      '240 enrolments for the autumn intake.',
      'Lift conversion from 18% to 26% rather than buying more leads.',
    ],
    painPoints: [
      '34% of applications abandon at the payment step.',
      'Parents ask for teacher information the landing page does not show.',
      'Night leads (after 22:00) do not answer calls.',
    ],
    decisionMakers: ['Alexey Petrov — head of sales, decides schedule and media windows.'],
    objections: [
      'Instalments may erode margin invisibly — calculation required before any promise.',
    ],
  },
  [company.chirchik]: {
    goals: ['First direct B2B shipments to Almaty and Astana buyers at sustainable margin.'],
    painPoints: [
      'Certificates for party 2 are pending about 14 days.',
      'Commercial proposals are drafted by hand for every buyer.',
      'Certification cost of 1.8M UZS per party is unallocated.',
    ],
    decisionMakers: ['Malika Ergasheva — operations lead, owns prepayment and production start.'],
    objections: ['Buyer pushes price to $6.05 at 12,000 m; our floor needs volume at 15,000 m.'],
  },
};
