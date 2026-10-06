import type { LanguageCode, MeetingProcessingState, Participant, ProcessingStep } from '../domain';
import type { transcriptLines } from './transcripts';
import { company, meeting, meetingType, person, project } from './ids';

/**
 * Meeting-level demo facts. Derived values (segment counts, decision counts, durations from transcripts) are
 * computed by `dataset.ts`, never authored here, so a summary row cannot disagree with its own children.
 */

export type DemoMeetingSeed = {
  id: string;
  /** Key into `meetingSlugs`/`transcriptLines`; `null` means the meeting has no audio or transcript yet. */
  transcript: keyof typeof transcriptLines | null;
  title: string;
  companyId: string | null;
  projectId: string | null;
  meetingTypeId: string;
  meetingTypeKey: string;
  meetingTypeLabel: string;
  occurredAt: string;
  /** Canonical meeting length (what the calendar/meeting represented). */
  durationMs: number;
  /** Captured audio length; `null` when nothing was captured. Deliberately separate from `durationMs`. */
  capturedMs: number | null;
  state: MeetingProcessingState;
  languages: LanguageCode[];
  origin: 'draft' | 'desktop' | 'upload';
  recording: {
    available: boolean;
    source: 'none' | 'local_desktop' | 'object_storage';
    note: string;
    manifestSessionId?: string;
  };
  participants: Participant[];
  executiveSummary: string[];
  keyOutcome?: string;
  unmappedSpeakers?: string[];
  steps?: ProcessingStep[];
  failure?: { code: string; message: string; hint?: string; retryable: boolean };
};

function internal(
  personId: string,
  name: string,
  initials: string,
  speakerLabel: string,
): Participant {
  return {
    personId,
    name,
    initials,
    kind: 'internal',
    speakerLabel,
    mapped: true,
    spokeInMeeting: true,
  };
}

function client(
  personId: string,
  name: string,
  initials: string,
  speakerLabel: string,
): Participant {
  return {
    personId,
    name,
    initials,
    kind: 'client',
    speakerLabel,
    mapped: true,
    spokeInMeeting: true,
  };
}

export const demoMeetingSeeds: DemoMeetingSeed[] = [
  {
    id: meeting.fooderaMarketing,
    transcript: 'fooderaMarketing',
    title: 'Foodera — Marketing Strategy',
    companyId: company.foodera,
    projectId: project.fooderaGrowth,
    meetingTypeId: meetingType.marketing,
    meetingTypeKey: 'marketing',
    meetingTypeLabel: 'Marketing',
    occurredAt: '2026-10-06T09:30:00Z',
    durationMs: 64 * 60_000,
    capturedMs: 61 * 60_000 + 42_000,
    state: 'ready',
    languages: ['uz', 'ru', 'en'],
    origin: 'desktop',
    recording: {
      available: true,
      source: 'local_desktop',
      note: 'Recording is stored on the capture machine by the desktop recorder (two separate sources, ~30 s chunks).',
      manifestSessionId: '5b2f0b3a-7f3b-4f0e-9f1c-demo00000001',
    },
    participants: [
      internal(person.elmurod, 'Elmurod Yusupov', 'EY', 'Speaker A'),
      client(person.dilshod, 'Dilshod Karimov', 'DK', 'Speaker B'),
      internal(person.aziz, 'Aziz Toshpulatov', 'AT', 'Speaker C'),
      internal(person.akmal, 'Akmal Rahimov', 'AR', 'Speaker D'),
      client(person.nigora, 'Nigora Abdullaeva', 'NA', 'Speaker E'),
      {
        personId: person.rustam,
        name: 'Rustam Alimov',
        initials: 'RA',
        kind: 'external',
        speakerLabel: 'Speaker F',
        mapped: true,
        spokeInMeeting: true,
      },
      client(person.malika, 'Malika Ergasheva', 'ME', 'Speaker G'),
    ],
    executiveSummary: [
      'October media budget stays at $5,000 — the team optimizes lead quality instead of expanding the target audience.',
      'Qualified lead definition was agreed for the first time: 3+ couriers, works with an aggregator, 300+ orders per month, all three captured as CRM fields.',
      'The form is cut from four steps to three fields plus two qualification questions, with a 24-hour call SLA inside business hours.',
      'Creative rotation becomes a standing pipeline (12 pieces per month, 10-day rotation) because frequency reached 4.2.',
      'One open risk remains unresolved: GA4 and amoCRM disagree on revenue attribution by 21%, so all revenue figures are marked provisional.',
    ],
    keyOutcome: 'Budget held, quality-first plan agreed, six owners assigned with dates.',
    steps: [
      {
        state: 'done',
        key: 'capture',
        label: 'Captured',
        at: '2026-10-06T10:34:12Z',
        detail: '2 sources · 129 chunks · manifest valid',
      },
      { state: 'done', key: 'upload', label: 'Uploaded', at: '2026-10-06T10:41:02Z' },
      {
        state: 'done',
        key: 'prepare',
        label: 'Transcript prepared',
        at: '2026-10-06T10:44:31Z',
        detail: '60 segments · 3 languages',
      },
      { state: 'done', key: 'transcribe', label: 'Transcribed', at: '2026-10-06T10:52:08Z' },
      { state: 'done', key: 'analyze', label: 'Analyzed', at: '2026-10-06T10:57:44Z' },
      { state: 'done', key: 'index', label: 'Indexed', at: '2026-10-06T10:58:10Z' },
    ],
  },
  {
    id: meeting.fooderaCreative,
    transcript: 'fooderaCreative',
    title: 'Foodera — Creative review for Q4 rotation',
    companyId: company.foodera,
    projectId: project.fooderaGrowth,
    meetingTypeId: meetingType.marketing,
    meetingTypeKey: 'marketing',
    meetingTypeLabel: 'Marketing',
    occurredAt: '2026-10-06T14:00:00Z',
    durationMs: 26 * 60_000,
    capturedMs: 24 * 60_000 + 18_000,
    state: 'analyzing',
    languages: ['uz', 'ru'],
    origin: 'desktop',
    recording: {
      available: true,
      source: 'local_desktop',
      note: 'Captured locally; transcript is ready, analysis is still running.',
      manifestSessionId: '5b2f0b3a-7f3b-4f0e-9f1c-demo00000002',
    },
    participants: [
      internal(person.akmal, 'Akmal Rahimov', 'AR', 'Speaker A'),
      client(person.malika, 'Malika Ergasheva', 'ME', 'Speaker B'),
      client(person.dilshod, 'Dilshod Karimov', 'DK', 'Speaker C'),
      client(person.nigora, 'Nigora Abdullaeva', 'NA', 'Speaker D'),
      internal(person.aziz, 'Aziz Toshpulatov', 'AT', 'Speaker E'),
      internal(person.elmurod, 'Elmurod Yusupov', 'EY', 'Speaker F'),
    ],
    executiveSummary: [
      'Twelve creatives per month was agreed as the rotation minimum; the first six ship by 15 October, the rest by 22 October.',
      'Promo-code variants are excluded from this launch because the current code has expired.',
    ],
    keyOutcome: 'Rotation volume agreed; production split by date.',
    steps: [
      { state: 'done', key: 'capture', label: 'Captured', at: '2026-10-06T14:26:40Z' },
      { state: 'done', key: 'upload', label: 'Uploaded', at: '2026-10-06T14:29:04Z' },
      {
        state: 'done',
        key: 'prepare',
        label: 'Transcript prepared',
        at: '2026-10-06T14:31:20Z',
        detail: '16 segments',
      },
      { state: 'done', key: 'transcribe', label: 'Transcribed', at: '2026-10-06T14:35:11Z' },
      {
        state: 'active',
        key: 'analyze',
        label: 'Analyzing',
        detail: 'Extracting decisions, tasks and facts',
      },
      { state: 'pending', key: 'index', label: 'Indexing' },
    ],
  },
  {
    id: meeting.fooderaCrmSync,
    transcript: 'fooderaCrmSync',
    title: 'Foodera — CRM rollout sync',
    companyId: company.foodera,
    projectId: project.fooderaCrm,
    meetingTypeId: meetingType.projectSync,
    meetingTypeKey: 'project_sync',
    meetingTypeLabel: 'Project sync',
    occurredAt: '2026-10-05T11:00:00Z',
    durationMs: 38 * 60_000,
    capturedMs: 36 * 60_000 + 2_000,
    state: 'ready',
    languages: ['ru', 'uz'],
    origin: 'desktop',
    recording: {
      available: true,
      source: 'local_desktop',
      note: 'Captured locally. Playback in this build is limited to the transcript and evidence view.',
      manifestSessionId: '5b2f0b3a-7f3b-4f0e-9f1c-demo00000003',
    },
    participants: [
      {
        personId: person.rustam,
        name: 'Rustam Alimov',
        initials: 'RA',
        kind: 'external',
        speakerLabel: 'Speaker A',
        mapped: true,
        spokeInMeeting: true,
      },
      internal(person.akmal, 'Akmal Rahimov', 'AR', 'Speaker B'),
      client(person.nigora, 'Nigora Abdullaeva', 'NA', 'Speaker C'),
      client(person.dilshod, 'Dilshod Karimov', 'DK', 'Speaker D'),
      internal(person.aziz, 'Aziz Toshpulatov', 'AT', 'Speaker E'),
    ],
    executiveSummary: [
      'CRM funnel is cut from 11 stages to six: New, Qualified, Demo, Proposal, Won, Lost.',
      'Four fields become mandatory, including refusal amount, so leads cannot be closed silently.',
      'The 24-hour SLA is implemented as an automatic task with a red flag after the deadline.',
    ],
    steps: [
      { state: 'done', key: 'capture', label: 'Captured', at: '2026-10-05T11:38:12Z' },
      { state: 'done', key: 'upload', label: 'Uploaded', at: '2026-10-05T11:40:02Z' },
      {
        state: 'done',
        key: 'prepare',
        label: 'Transcript prepared',
        at: '2026-10-05T11:41:31Z',
        detail: '14 segments',
      },
      { state: 'done', key: 'transcribe', label: 'Transcribed', at: '2026-10-05T11:45:08Z' },
      { state: 'done', key: 'analyze', label: 'Analyzed', at: '2026-10-05T11:49:44Z' },
      { state: 'done', key: 'index', label: 'Indexed', at: '2026-10-05T11:50:10Z' },
    ],
  },
  {
    id: meeting.nomadPipeline,
    transcript: 'nomadPipeline',
    title: 'Nomad Education — Q3 pipeline review',
    companyId: company.nomad,
    projectId: project.nomadIntake,
    meetingTypeId: meetingType.sales,
    meetingTypeKey: 'sales',
    meetingTypeLabel: 'Sales review',
    occurredAt: '2026-10-02T16:30:00Z',
    durationMs: 52 * 60_000,
    capturedMs: 47 * 60_000 + 30_000,
    state: 'ready',
    languages: ['ru', 'uz'],
    origin: 'upload',
    recording: {
      available: true,
      source: 'object_storage',
      note: 'Audio was uploaded by the client; speaker mapping is still incomplete.',
    },
    participants: [
      client(person.alexey, 'Alexey Petrov', 'AP', 'Speaker A'),
      internal(person.akmal, 'Akmal Rahimov', 'AR', 'Speaker B'),
      // No participant entry for Speaker C on purpose: the label is not yet attributed to a person, so the
      // mapping UI has real work to do and nothing pretends the identity is known.
      client(person.malika, 'Malika Ergasheva', 'ME', 'Speaker D'),
      client(person.nigora, 'Nigora Abdullaeva', 'NA', 'Speaker E'),
    ],
    unmappedSpeakers: ['Speaker C'],
    executiveSummary: [
      'The team keeps the same lead volume and targets conversion instead: 18% → 26% for the autumn intake.',
      'Two structural blockers were identified: 34% of applications abandon at payment, and parents ask for teacher profiles that the landing page does not show.',
      'Saturday slots are added; the instalment plan waits for a unit-economics calculation before any commitment.',
    ],
    keyOutcome: 'Conversion-first plan; one speaker still unmapped.',
    steps: [
      { state: 'done', key: 'upload', label: 'Uploaded', at: '2026-10-02T17:26:00Z' },
      {
        state: 'done',
        key: 'prepare',
        label: 'Transcript prepared',
        at: '2026-10-02T17:31:00Z',
        detail: '14 segments · 1 unmapped speaker',
      },
      { state: 'done', key: 'transcribe', label: 'Transcribed', at: '2026-10-02T17:44:00Z' },
      { state: 'done', key: 'analyze', label: 'Analyzed', at: '2026-10-02T17:51:00Z' },
      { state: 'done', key: 'index', label: 'Indexed', at: '2026-10-02T17:52:00Z' },
    ],
  },
  {
    id: meeting.chirchikExport,
    transcript: 'chirchikExport',
    title: 'Chirchik Textile — Export review',
    companyId: company.chirchik,
    projectId: project.chirchikExport,
    meetingTypeId: meetingType.customerCall,
    meetingTypeKey: 'customer_call',
    meetingTypeLabel: 'Customer call',
    occurredAt: '2026-09-28T10:00:00Z',
    durationMs: 44 * 60_000,
    capturedMs: 41 * 60_000 + 12_000,
    state: 'failed',
    languages: ['ru', 'uz', 'en'],
    origin: 'desktop',
    recording: {
      available: true,
      source: 'local_desktop',
      note: 'Audio and transcript are usable; the analysis run failed, so decisions below are the ones the team typed manually.',
      manifestSessionId: '5b2f0b3a-7f3b-4f0e-9f1c-demo00000004',
    },
    participants: [
      client(person.malika, 'Malika Ergasheva', 'ME', 'Speaker A'),
      internal(person.akmal, 'Akmal Rahimov', 'AR', 'Speaker B'),
      internal(person.aziz, 'Aziz Toshpulatov', 'AT', 'Speaker C'),
      internal(person.elmurod, 'Elmurod Yusupov', 'EY', 'Speaker D'),
    ],
    executiveSummary: [
      'Pricing converged around $6.20 per metre with 15,000 m volume and 30% prepayment; certification cost is still open.',
      'The transcript is complete and readable even though the analysis run failed — capture and processing are independent on purpose.',
    ],
    keyOutcome: 'Commercial shape agreed; one open question on certification cost.',
    steps: [
      { state: 'done', key: 'capture', label: 'Captured', at: '2026-09-28T10:41:12Z' },
      { state: 'done', key: 'upload', label: 'Uploaded', at: '2026-09-28T10:44:02Z' },
      {
        state: 'done',
        key: 'prepare',
        label: 'Transcript prepared',
        at: '2026-09-28T10:46:31Z',
        detail: '12 segments',
      },
      { state: 'done', key: 'transcribe', label: 'Transcribed', at: '2026-09-28T10:52:08Z' },
      {
        state: 'failed',
        key: 'analyze',
        label: 'Analysis failed',
        detail: 'Provider returned an oversized payload',
      },
      { state: 'pending', key: 'index', label: 'Indexing' },
    ],
    failure: {
      code: 'analysis_payload_too_large',
      message: 'The analysis run stopped because the transcript batch exceeded the provider limit.',
      hint: 'Retrying re-runs analysis only; the transcript and recording are untouched.',
      retryable: true,
    },
  },
  {
    id: meeting.boardQ4,
    transcript: 'boardQ4',
    title: 'Suhbat Studio — Q4 planning',
    companyId: null,
    projectId: null,
    meetingTypeId: meetingType.board,
    meetingTypeKey: 'board',
    meetingTypeLabel: 'Board',
    occurredAt: '2026-09-21T18:00:00Z',
    durationMs: 71 * 60_000,
    capturedMs: 68 * 60_000 + 5_000,
    state: 'ready',
    languages: ['uz', 'ru', 'en'],
    origin: 'desktop',
    recording: {
      available: true,
      source: 'local_desktop',
      note: 'Internal meeting, no company attached.',
      manifestSessionId: '5b2f0b3a-7f3b-4f0e-9f1c-demo00000005',
    },
    participants: [
      internal(person.elmurod, 'Elmurod Yusupov', 'EY', 'Speaker A'),
      internal(person.akmal, 'Akmal Rahimov', 'AR', 'Speaker B'),
      internal(person.aziz, 'Aziz Toshpulatov', 'AT', 'Speaker C'),
      client(person.malika, 'Malika Ergasheva', 'ME', 'Speaker D'),
    ],
    executiveSummary: [
      'Q4 focus stays on small teams; enterprise features are postponed to next year.',
      'Two hires are prioritised: a growth engineer and a Rust systems engineer; if the Rust role is unfilled by 1 December, the Windows backend moves a quarter.',
      'Pricing moves to $45 per seat for new customers only, keeping pilot pricing for existing accounts.',
    ],
    keyOutcome: 'Roadmap, hiring and pricing decided; board deck due 20 November.',
    steps: [
      { state: 'done', key: 'capture', label: 'Captured', at: '2026-09-21T19:11:00Z' },
      { state: 'done', key: 'upload', label: 'Uploaded', at: '2026-09-21T19:13:00Z' },
      {
        state: 'done',
        key: 'prepare',
        label: 'Transcript prepared',
        at: '2026-09-21T19:16:00Z',
        detail: '12 segments',
      },
      { state: 'done', key: 'transcribe', label: 'Transcribed', at: '2026-09-21T19:24:00Z' },
      { state: 'done', key: 'analyze', label: 'Analyzed', at: '2026-09-21T19:29:00Z' },
      { state: 'done', key: 'index', label: 'Indexed', at: '2026-09-21T19:30:00Z' },
    ],
  },
  {
    id: 'meeting_foodera_budget_checkin',
    transcript: null,
    title: 'Foodera — October budget check-in',
    companyId: company.foodera,
    projectId: project.fooderaGrowth,
    meetingTypeId: meetingType.planning,
    meetingTypeKey: 'planning',
    meetingTypeLabel: 'Planning',
    occurredAt: '2026-10-06T16:45:00Z',
    durationMs: 30 * 60_000,
    capturedMs: null,
    state: 'draft',
    languages: ['uz'],
    origin: 'draft',
    recording: {
      available: false,
      source: 'none',
      note: 'Draft only — no audio captured yet, so nothing can be played, transcribed or analysed.',
    },
    participants: [],
    executiveSummary: [],
    keyOutcome: 'Scheduled; recording not started.',
    steps: [{ state: 'pending', key: 'capture', label: 'Not recorded yet' }],
  },
];
