import type { Company, MeetingType, Person, Project, WorkspaceSummary } from '../domain';
import { DEMO_WORKSPACE_ID, company, meetingType, person, project } from './ids';

/**
 * Who, what company, which project, which meeting type. Meetings themselves live in `meetings.ts`;
 * analysis artifacts in `analysis.ts`. Nothing here encodes a claim about another entity — the dataset
 * builder derives counts and resolves references, so a mismatch is impossible to author silently.
 */

export const DEMO_TODAY_ISO_DATE = '2026-10-06';
export const DEMO_GENERATED_AT = '2026-10-06T18:20:00Z';

export const demoWorkspace: WorkspaceSummary = {
  id: DEMO_WORKSPACE_ID,
  name: 'Suhbat Studio',
  slug: 'suhbat-studio',
  role: 'admin',
  memberCount: 6,
  demo: true,
};

export const demoPeople: Person[] = [
  {
    id: person.elmurod,
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Elmurod Yusupov',
    initials: 'EY',
    title: 'Co-founder · Strategy',
    kind: 'internal',
    email: 'elmurod@suhbat.example',
  },
  {
    id: person.akmal,
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Akmal Rahimov',
    initials: 'AR',
    title: 'Growth lead',
    kind: 'internal',
    email: 'akmal@suhbat.example',
  },
  {
    id: person.aziz,
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Aziz Toshpulatov',
    initials: 'AT',
    title: 'Data & analytics',
    kind: 'internal',
    email: 'aziz@suhbat.example',
  },
  {
    id: person.dilshod,
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Dilshod Karimov',
    initials: 'DK',
    title: 'Marketing manager · Foodera',
    kind: 'client',
  },
  {
    id: person.nigora,
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Nigora Abdullaeva',
    initials: 'NA',
    title: 'Account manager · Foodera',
    kind: 'client',
  },
  {
    id: person.rustam,
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Rustam Alimov',
    initials: 'RA',
    title: 'CRM consultant',
    kind: 'external',
  },
  {
    id: person.alexey,
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Alexey Petrov',
    initials: 'AP',
    title: 'Head of sales · Nomad Education',
    kind: 'client',
  },
  {
    id: person.malika,
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Malika Ergasheva',
    initials: 'ME',
    title: 'Operations lead · Chirchik Textile',
    kind: 'client',
  },
];

export const demoCompanies: Company[] = [
  {
    id: company.foodera,
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Foodera',
    description:
      'City food-delivery service. Growth engagement focused on paid acquisition quality and CRM discipline.',
    status: 'active',
    createdAt: '2026-05-11T09:00:00Z',
  },
  {
    id: company.nomad,
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Nomad Education',
    description: 'English-language school network. Seasonal intake, sales-led enrolment funnel.',
    status: 'active',
    createdAt: '2026-06-02T10:30:00Z',
  },
  {
    id: company.chirchik,
    workspaceId: DEMO_WORKSPACE_ID,
    name: 'Chirchik Textile Mills',
    description:
      'Manufacturer exploring direct export channels and buyer relationships in Kazakhstan.',
    status: 'active',
    createdAt: '2026-07-19T08:15:00Z',
  },
];

export const demoProjects: Project[] = [
  {
    id: project.fooderaGrowth,
    workspaceId: DEMO_WORKSPACE_ID,
    companyId: company.foodera,
    name: 'Growth Sprint Q4',
    description: 'Raise qualified-lead share without raising the monthly media budget.',
    status: 'active',
    createdAt: '2026-09-07T09:00:00Z',
    lastActivityAt: DEMO_GENERATED_AT,
  },
  {
    id: project.fooderaCrm,
    workspaceId: DEMO_WORKSPACE_ID,
    companyId: company.foodera,
    name: 'CRM Rollout',
    description: 'Move lead handling into amoCRM with owners, stages and a 24-hour follow-up rule.',
    status: 'active',
    createdAt: '2026-09-14T11:00:00Z',
    lastActivityAt: '2026-10-05T11:38:00Z',
  },
  {
    id: project.nomadIntake,
    workspaceId: DEMO_WORKSPACE_ID,
    companyId: company.nomad,
    name: 'Autumn Intake',
    description: 'Enrolment campaign for the October and November cohorts.',
    status: 'active',
    createdAt: '2026-08-24T09:00:00Z',
    lastActivityAt: '2026-10-02T17:22:00Z',
  },
  {
    id: project.chirchikExport,
    workspaceId: DEMO_WORKSPACE_ID,
    companyId: company.chirchik,
    name: 'Export Pipeline',
    description: 'First direct B2B shipments to Almaty and Astana buyers.',
    status: 'paused',
    createdAt: '2026-09-01T09:00:00Z',
    lastActivityAt: '2026-09-28T10:44:00Z',
  },
];

export const demoMeetingTypes: MeetingType[] = [
  {
    id: meetingType.marketing,
    workspaceId: DEMO_WORKSPACE_ID,
    key: 'marketing',
    displayName: 'Marketing',
    sortOrder: 10,
    builtIn: true,
    active: true,
  },
  {
    id: meetingType.sales,
    workspaceId: DEMO_WORKSPACE_ID,
    key: 'sales',
    displayName: 'Sales review',
    sortOrder: 20,
    builtIn: true,
    active: true,
  },
  {
    id: meetingType.projectSync,
    workspaceId: DEMO_WORKSPACE_ID,
    key: 'project_sync',
    displayName: 'Project sync',
    sortOrder: 30,
    builtIn: true,
    active: true,
  },
  {
    id: meetingType.customerCall,
    workspaceId: DEMO_WORKSPACE_ID,
    key: 'customer_call',
    displayName: 'Customer call',
    sortOrder: 40,
    builtIn: true,
    active: true,
  },
  {
    id: meetingType.board,
    workspaceId: DEMO_WORKSPACE_ID,
    key: 'board',
    displayName: 'Board',
    sortOrder: 50,
    builtIn: true,
    active: true,
  },
  {
    id: meetingType.planning,
    workspaceId: DEMO_WORKSPACE_ID,
    key: 'planning',
    displayName: 'Planning',
    sortOrder: 60,
    builtIn: true,
    active: true,
  },
  {
    id: meetingType.oneOnOne,
    workspaceId: DEMO_WORKSPACE_ID,
    key: 'one_on_one',
    displayName: '1:1',
    sortOrder: 70,
    builtIn: true,
    active: true,
  },
  {
    id: meetingType.retro,
    workspaceId: DEMO_WORKSPACE_ID,
    key: 'retro',
    displayName: 'Retro',
    sortOrder: 80,
    builtIn: true,
    active: true,
  },
];

export const demoVocabulary = [
  {
    id: 'vocab_1',
    workspaceId: DEMO_WORKSPACE_ID,
    term: 'Foodera',
    context: 'Client company name; often misheard as “Futura”.',
    scope: 'workspace' as const,
    companyId: null,
    meetingId: null,
    enabled: true,
  },
  {
    id: 'vocab_2',
    workspaceId: DEMO_WORKSPACE_ID,
    term: 'amoCRM',
    context: 'CRM vendor; capitalisation matters in exported tasks.',
    scope: 'workspace' as const,
    companyId: null,
    meetingId: null,
    enabled: true,
  },
  {
    id: 'vocab_3',
    workspaceId: DEMO_WORKSPACE_ID,
    term: 'lead qualification rate',
    context: 'Metric the client reports weekly; also “qual ulush” in Uzbek.',
    scope: 'company' as const,
    companyId: company.foodera,
    meetingId: null,
    enabled: true,
  },
];
