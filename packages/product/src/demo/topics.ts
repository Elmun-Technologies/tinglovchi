import type { LineRange, MeetingKey } from './ranges';
import { topic } from './ids';

/**
 * Topic map fixtures. A topic is a *section of the transcript* with a summary, so it is authored as a line
 * range over that meeting and the builder attaches the real segment ids and time envelope.
 *
 * Non-overlapping sibling ranges are deliberate: two topics claiming the same segments would make
 * "clicking a topic exposes linked transcript sections" ambiguous.
 */
export type DemoTopicSeed = {
  id: string;
  meetingKey: MeetingKey;
  parentId: string | null;
  title: string;
  summary: string;
  keywords: string[];
  lines: LineRange;
  participantPersonIds: string[];
};

export const demoTopicSeeds: DemoTopicSeed[] = [
  // Foodera — Marketing Strategy (59 lines, ~64 min)
  {
    id: topic.marketing,
    meetingKey: 'fooderaMarketing',
    parentId: null,
    title: 'Marketing',
    summary:
      'September performance review and the quality-first plan for October, including the funnel diagnosis and creative rotation.',
    keywords: ['lead quality', 'funnel', 'CTR', 'rotation'],
    lines: [1, 19],
    participantPersonIds: [],
  },
  {
    id: topic.leadQuality,
    meetingKey: 'fooderaMarketing',
    parentId: topic.marketing,
    title: 'Lead quality & funnel',
    summary:
      'Qualified share is 57% against a 70% target; the biggest loss (41%) is between form submit and manager call, worst on paid channels.',
    keywords: ['qualification rate', 'form steps', 'Meta', 'Google'],
    lines: [1, 8],
    participantPersonIds: [],
  },
  {
    id: topic.conversion,
    meetingKey: 'fooderaMarketing',
    parentId: topic.marketing,
    title: 'Conversion fixes',
    summary:
      'Three changes agreed before any audience expansion: shorter form, qualification questions, and a 24-hour call SLA in business hours.',
    keywords: ['form', 'SLA', '24 hours', 'sales capacity'],
    lines: [9, 13],
    participantPersonIds: [],
  },
  {
    id: topic.creatives,
    meetingKey: 'fooderaMarketing',
    parentId: topic.marketing,
    title: 'Creatives',
    summary:
      'UGC outperforms studio on CTR but costs more per qualified lead; frequency 4.2 forces a 10-day rotation and an in-house pipeline.',
    keywords: ['UGC', 'studio', 'frequency', 'Advantage+'],
    lines: [14, 19],
    participantPersonIds: [],
  },
  {
    id: topic.sales,
    meetingKey: 'fooderaMarketing',
    parentId: null,
    title: 'Sales',
    summary:
      'CRM discipline and audience geography — the two places where lead quality is decided after the click.',
    keywords: ['amoCRM', 'stages', 'geo', 'radius'],
    lines: [20, 28],
    participantPersonIds: [],
  },
  {
    id: topic.crm,
    meetingKey: 'fooderaMarketing',
    parentId: topic.sales,
    title: 'CRM & data entry',
    summary:
      'Measure CPL and revenue per lead from amoCRM data; the funnel simplification itself waits for the next sprint because of the six-person team load.',
    keywords: ['CPL', 'revenue per lead', 'stages'],
    lines: [20, 23],
    participantPersonIds: [],
  },
  {
    id: topic.audience,
    meetingKey: 'fooderaMarketing',
    parentId: topic.sales,
    title: 'Audience',
    summary:
      'Radius 3–5 km, 18–45. Center is more expensive but converts better; narrowing risks the order volume the owner cares about.',
    keywords: ['radius', 'Yunusabad', 'Chilonzor', 'CPL'],
    lines: [24, 28],
    participantPersonIds: [],
  },
  {
    id: topic.commercial,
    meetingKey: 'fooderaMarketing',
    parentId: null,
    title: 'Commercial',
    summary:
      'Budget, attribution and the definition of a qualified lead — the money and measurement decisions.',
    keywords: ['budget', 'attribution', 'definition'],
    lines: [29, 44],
    participantPersonIds: [],
  },
  {
    id: topic.budget,
    meetingKey: 'fooderaMarketing',
    parentId: topic.commercial,
    title: 'Budget',
    summary:
      'October stays at $5,000 with $800 carved out of it for a Google PMax test; no audience expansion money this month.',
    keywords: ['$5,000', 'PMax', '$800 test'],
    lines: [29, 30],
    participantPersonIds: [],
  },
  {
    id: topic.proposal,
    meetingKey: 'fooderaMarketing',
    parentId: topic.commercial,
    title: 'Measurement & qualification',
    summary:
      'amoCRM is the financial source of truth, GA4 plans media; qualified means 3+ couriers, aggregator work, 300+ monthly orders.',
    keywords: ['GA4', 'amoCRM', 'qualified lead', '21% gap'],
    lines: [31, 40],
    participantPersonIds: [],
  },
  {
    id: topic.reactivation,
    meetingKey: 'fooderaMarketing',
    parentId: topic.commercial,
    title: 'Reactivate dormant clients',
    summary:
      'WhatsApp flow for 12,400 dormant customers was raised as an idea, not a commitment — it needs the revenue case first.',
    keywords: ['WhatsApp', 'dormant clients', 'idea'],
    lines: [41, 44],
    participantPersonIds: [],
  },
  {
    id: topic.nextSteps,
    meetingKey: 'fooderaMarketing',
    parentId: null,
    title: 'Next steps',
    summary:
      'Owners, dates, weekly rhythm and the two dependencies: form-to-CRM integration and dashboard access for the client team.',
    keywords: ['owners', 'deadlines', 'weekly review'],
    lines: [45, 58],
    participantPersonIds: [],
  },

  // Foodera — CRM rollout sync (14 lines)
  {
    id: 'topic_crm_stages',
    meetingKey: 'fooderaCrmSync',
    parentId: null,
    title: 'Funnel & mandatory fields',
    summary: 'Eleven stages become six; four fields become required, including refusal amount.',
    keywords: ['stages', 'required fields', 'refusal amount'],
    lines: [0, 3],
    participantPersonIds: [],
  },
  {
    id: 'topic_crm_automation',
    meetingKey: 'fooderaCrmSync',
    parentId: null,
    title: 'SLA automation & migration',
    summary:
      '24-hour SLA as an automatic task with a red flag; 8,600 legacy leads deduplicated by phone and company.',
    keywords: ['SLA', 'deduplication', 'import'],
    lines: [4, 8],
    participantPersonIds: [],
  },
  {
    id: 'topic_crm_ux',
    meetingKey: 'fooderaCrmSync',
    parentId: null,
    title: 'Field usability',
    summary:
      'Mobile use and Russian UI stay; field labels are corrected in Uzbek instead of switching languages.',
    keywords: ['mobile', 'localisation', 'labels'],
    lines: [9, 13],
    participantPersonIds: [],
  },

  // Nomad Education — Q3 pipeline review (14 lines)
  {
    id: 'topic_nomad_funnel',
    meetingKey: 'nomadPipeline',
    parentId: null,
    title: 'Enrolment funnel',
    summary: 'Target is conversion (18% → 26%), not volume; 34% abandon at the payment step.',
    keywords: ['conversion', 'abandonment', 'payment step'],
    lines: [0, 3],
    participantPersonIds: [],
  },
  {
    id: 'topic_nomad_offer',
    meetingKey: 'nomadPipeline',
    parentId: null,
    title: 'Schedule & offer',
    summary:
      'Saturday slots approved; instalments wait for unit economics. Ads stop at 22:00 because night leads do not answer, and teacher profiles go on the landing page.',
    keywords: ['Saturday slots', 'instalments', 'night leads', 'teacher profiles'],
    lines: [6, 13],
    participantPersonIds: [],
  },

  // Chirchik Textile — Export review (12 lines)
  {
    id: 'topic_chirchik_commercial',
    meetingKey: 'chirchikExport',
    parentId: null,
    title: 'Commercial terms',
    summary: '$6.20 per metre at 15,000 m with 30% prepayment; balance 10 days after delivery.',
    keywords: ['price per metre', 'prepayment', 'volume'],
    lines: [3, 6],
    participantPersonIds: [],
  },
  {
    id: 'topic_chirchik_delivery',
    meetingKey: 'chirchikExport',
    parentId: null,
    title: 'Certification & logistics',
    summary:
      'Certificates pending ~14 days; party 1 ships regardless. Who pays certification (1.8M UZN/party) stays open.',
    keywords: ['certificates', 'logistics', 'party 1'],
    lines: [0, 2],
    participantPersonIds: [],
  },
  {
    id: 'topic_chirchik_open_items',
    meetingKey: 'chirchikExport',
    parentId: null,
    title: 'Open items & follow-ups',
    summary:
      'Certification cost ownership is unresolved; logistics quote and a proposal template are the two actions.',
    keywords: ['certification cost', 'quote', 'proposal template'],
    lines: [7, 11],
    participantPersonIds: [],
  },

  // Board — Q4 planning (12 lines)
  {
    id: 'topic_board_focus',
    meetingKey: 'boardQ4',
    parentId: null,
    title: 'Q4 focus & metrics',
    summary:
      'ARR target $180K, three active paying customers, stable desktop recorder; enterprise work postponed.',
    keywords: ['ARR', 'retention', 'scope'],
    lines: [0, 3],
    participantPersonIds: [],
  },
  {
    id: 'topic_board_hiring',
    meetingKey: 'boardQ4',
    parentId: null,
    title: 'Hiring & pricing',
    summary: 'Two hires with an eight-week cycle; pricing test at $45/seat for new customers only.',
    keywords: ['Rust engineer', 'growth engineer', 'pricing'],
    lines: [4, 11],
    participantPersonIds: [],
  },

  // Foodera — Creative review (16 lines)
  {
    id: 'topic_creative_launch',
    meetingKey: 'fooderaCreative',
    parentId: null,
    title: 'Launch set',
    summary:
      'Six scripts and three studio variants reviewed; courier-on-screen variants lead, one Uzbek text overlay is required, expired promo codes are excluded.',
    keywords: ['UGC scripts', 'Uzbek text', 'promo code'],
    lines: [0, 5],
    participantPersonIds: [],
  },
  {
    id: 'topic_creative_rotation',
    meetingKey: 'fooderaCreative',
    parentId: null,
    title: 'Rotation volume & measurement',
    summary:
      'Twelve creatives per month, six by 15 October and the rest by 22 October; brief measured on CPL and CTR floor, not views.',
    keywords: ['12 creatives', 'CPL', 'rotation', 'CTR 2.2%'],
    lines: [6, 13],
    participantPersonIds: [],
  },
  {
    id: 'topic_creative_production',
    meetingKey: 'fooderaCreative',
    parentId: null,
    title: 'Production budget',
    summary:
      '$900 of production budget left this month covers six pieces; whether an outside crew is worth 40% more is still open.',
    keywords: ['$900', 'contractor', 'schedule risk'],
    lines: [14, 15],
    participantPersonIds: [],
  },
];
