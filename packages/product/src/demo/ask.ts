import type { AskAiAnswer, AskAiCitation } from '../domain';
import { formatTimestamp } from '../domain';
import { normalizeText, retrieve, type Retrievable } from '../query';
import type { DemoDataset } from './dataset';

/**
 * Deterministic, retrieval-backed answers for demo mode.
 *
 * There is no model call here and nothing to configure: a question is tokenized, scored against the demo
 * corpus by distinct-token overlap (`retrieve`), and the answer is composed from the matched records. Known
 * example questions have hand-authored answers whose citations are resolved against the fixtures at build
 * time — if a cited record is renamed or deleted, `buildAskAnswer` throws instead of shipping a broken
 * answer. Real RAG replaces this file's caller, not the UI.
 */

export type KnownAnswer = {
  question: string;
  answer: string[];
  /** `kind:id` pairs resolved against the dataset, so a stale citation fails loudly. */
  cites: string[];
};

export const demoKnownQuestions: KnownAnswer[] = [
  {
    question: 'Foodera bilan budget haqida nima kelishganmiz?',
    answer: [
      'Oktyabr byudjeti o‘zgarishsiz — $5 000. Kengaytirish puli ajratilmadi; sababi — auditoriyani toraytirish buyurtma hajmini pasaytirish xavfini beradi.',
      'Shu $5 000 ichidan $800 Google PMax testiga ajratildi, Meta’ga bog‘liqlikni kamaytirish uchun.',
      'Byudjet qarori bilan birga kvalifikatsiya qoidasi ham tasdiqlandi: 3+ kuryer, agregator bilan ishlash, oyiga 300+ buyurtma — uchinchi mezon Dilshod iltimosi bilan 500 dan 300 ga tushirildi.',
    ],
    cites: [
      'decision:dec_foodera_budget_held',
      'decision:dec_foodera_qualified_definition',
      'fact:fact_foodera_budget',
    ],
  },
  {
    question: 'Akmal zimmasida qanday vazifalar qolgan?',
    answer: [
      'Akmalga biriktirilgan ochiq vazifalar: 6 ta UGC skriptini sentyabr statistikasiga moslab qayta yozish (15-oktabr), 24 soatlik qo‘ng‘iroq SLA qoidasini yozish (8-oktabr, jarayonda), Dilshod va Nigoraga lead-score dashboard’iga read-only access berish (13-oktabr), kreativ brief’ida metrikani CPL ga o‘zgartirish (12-oktabr), va Q4 roadmap hujjati (9-oktabr).',
      'Nomad bo‘yicha ham bitta vazifa bor: o‘qituvchi profillarini landing sahifasiga chiqarish (9-oktabr).',
    ],
    cites: [
      'task:task_foodera_ugc_rewrites',
      'task:task_foodera_sla_rule',
      'task:task_foodera_dashboard_access',
      'task:task_board_roadmap_doc',
      'task:task_creative_brief_update',
    ],
  },
  {
    question: 'Oxirgi oy marketing bo‘yicha qanday qarorlar bo‘lgan?',
    answer: [
      'Marketing bo‘yicha tasdiqlangan qarorlar: kreativ pipeline’ni ichida qilish (oyiga 12 ta UGC + 4 ta studio, 10 kunlik rotatsiya), forma 3 ta maydonga qisqartirilib 2 ta kvalifikatsiya savoli qo‘shish, va Advantage+ ni ikki haftaga o‘chirib turish (hali tentative).',
      'Kreativ review’da qo‘shimcha ravishda: promo kodi eskirgani uchun bu launch kodsiz variantlar bilan chiqadi.',
    ],
    cites: [
      'decision:dec_foodera_creative_pipeline',
      'decision:dec_foodera_form_sla',
      'decision:dec_foodera_advantage_off',
      'decision:dec_creative_no_promo_code',
    ],
  },
  {
    question: 'Clientning objectionlarini chiqar.',
    answer: [
      'Foodera: forma qisqarsa leadlar soni kamayadi degan xavotir — sifat oshishining kafolati yo‘q, shuning uchun radius toraytirilmadi; qoida — avval sifat. Ikkinchisi: CRM integratsiyasi bo‘lmasa jarayon o‘ladi, tegishli commitment Rustam ustida.',
      'Foodera CRM: “managerlar majburiy maydonlarni mobil oqimsiz to‘ldirmaydi” — hozir ochiq savol.',
      'Chirchik: xaridor $6.05 ni 12 000 metrda so‘rayapti; bizning past chegarimiz 15 000 metrda $6.20.',
      'Nomad: рассрочка marjani sekin yeyishi mumkin — hisob-kitob tayyor bo‘lmasicha hech narsa va‘da qilinmaydi.',
    ],
    cites: [
      'question:q_foodera_volume_risk',
      'commitment:commit_rustam_integration',
      'question:q_crm_mobile_capacity',
      'decision:dec_chirchik_price_620',
      'decision:dec_nomad_instalments',
    ],
  },
  {
    question: 'What is still unresolved about our revenue numbers?',
    answer: [
      'GA4 and amoCRM disagree on revenue attribution by 21%. The agreed rule is amoCRM for financial reporting and GA4 for media planning, with a reconciliation table due in two weeks from Aziz.',
      'Until then every revenue figure in these meetings is explicitly marked provisional, including the owner report.',
    ],
    cites: [
      'fact:fact_foodera_attribution_gap',
      'question:q_foodera_attribution',
      'task:task_foodera_owner_report',
    ],
  },
];

function citationFor(dataset: DemoDataset, ref: string): AskAiCitation | null {
  const [kind, id] = ref.split(':', 2) as [string, string];
  const meetingCitation = (
    meetingId: string,
    startMs: number,
    endMs: number,
    segmentIds: string[],
  ) => {
    const meeting = dataset.meetings.find((item) => item.id === meetingId);
    const segments = (dataset.transcripts[meetingId]?.segments ?? []).filter((segment) =>
      segmentIds.includes(segment.id),
    );
    return {
      meetingId,
      meetingTitle: meeting?.title ?? 'Unknown meeting',
      occurredAt: meeting?.occurredAt ?? dataset.generatedAt,
      startMs,
      endMs,
      // Carried so a source card can deep-link to the exact line; empty means "we only have a time range".
      segmentIds,
      speakerNames: [
        ...new Set(
          segments.map(
            (segment) =>
              dataset.people.find((individual) => individual.id === segment.speakerPersonId)
                ?.name ?? segment.speakerLabel,
          ),
        ),
      ],
    };
  };

  if (kind === 'decision') {
    const decision = dataset.decisions.find((item) => item.id === id);
    if (!decision) return null;
    const evidence = decision.evidence[0]!;
    return {
      kind: 'decision',
      id: decision.id,
      ...meetingCitation(decision.meetingId, evidence.startMs, evidence.endMs, evidence.segmentIds),
      quote: decision.title,
      target: 'decisions',
    };
  }
  if (kind === 'task') {
    const task = dataset.tasks.find((item) => item.id === id);
    if (!task) return null;
    const evidence = task.evidence[0]!;
    return {
      kind: 'task',
      id: task.id,
      ...meetingCitation(task.meetingId, evidence.startMs, evidence.endMs, evidence.segmentIds),
      quote: `${task.title}${task.dueDate ? ` — due ${task.dueDate}` : ''}`,
      target: 'tasks',
    };
  }
  if (kind === 'fact') {
    const fact = dataset.facts.find((item) => item.id === id);
    if (!fact) return null;
    const evidence = fact.evidence[0]!;
    return {
      kind: 'fact',
      id: fact.id,
      ...meetingCitation(fact.meetingId, evidence.startMs, evidence.endMs, evidence.segmentIds),
      quote: `${fact.label}: ${fact.value}${fact.unit ? ` ${fact.unit}` : ''}`,
      target: 'facts',
    };
  }
  if (kind === 'question') {
    const question = dataset.questions.find((item) => item.id === id);
    if (!question) return null;
    const evidence = question.evidence[0]!;
    return {
      kind: 'question',
      id: question.id,
      ...meetingCitation(question.meetingId, evidence.startMs, evidence.endMs, evidence.segmentIds),
      quote: question.text,
      target: 'questions',
    };
  }
  if (kind === 'idea') {
    const idea = dataset.ideas.find((item) => item.id === id);
    if (!idea) return null;
    const evidence = idea.evidence[0]!;
    return {
      kind: 'idea',
      id: idea.id,
      ...meetingCitation(idea.meetingId, evidence.startMs, evidence.endMs, evidence.segmentIds),
      quote: idea.text,
      target: 'ideas',
    };
  }
  if (kind === 'commitment') {
    const commitment = dataset.commitments.find((item) => item.id === id);
    if (!commitment) return null;
    const evidence = commitment.evidence[0]!;
    return {
      kind: 'commitment',
      id: commitment.id,
      ...meetingCitation(
        commitment.meetingId,
        evidence.startMs,
        evidence.endMs,
        evidence.segmentIds,
      ),
      quote: commitment.text,
      target: 'overview',
    };
  }
  if (kind === 'segment') {
    for (const [meetingId, transcript] of Object.entries(dataset.transcripts)) {
      const segment = transcript.segments.find((item) => item.id === id);
      if (segment) {
        return {
          kind: 'segment',
          id: segment.id,
          ...meetingCitation(meetingId, segment.startMs, segment.endMs, [segment.id]),
          quote: segment.text,
          target: 'transcript',
        };
      }
    }
  }
  return null;
}

function retrievableItems(dataset: DemoDataset): Retrievable[] {
  const items: Retrievable[] = [];
  for (const decision of dataset.decisions) {
    items.push({
      id: `decision:${decision.id}`,
      kind: 'decision',
      title: decision.title,
      body: decision.description,
      meetingId: decision.meetingId,
      tags: [decision.status],
    });
  }
  for (const task of dataset.tasks) {
    items.push({
      id: `task:${task.id}`,
      kind: 'task',
      title: task.title,
      body: [task.detail, task.ownerLabel, task.status].filter(Boolean).join(' '),
      meetingId: task.meetingId,
      tags: [task.status, task.priority],
    });
  }
  for (const fact of dataset.facts) {
    items.push({
      id: `fact:${fact.id}`,
      kind: 'fact',
      title: fact.label,
      body: `${fact.value} ${fact.unit ?? ''}`,
      meetingId: fact.meetingId,
      tags: [fact.category],
    });
  }
  for (const question of dataset.questions) {
    items.push({
      id: `question:${question.id}`,
      kind: 'question',
      title: question.text,
      body: question.resolution?.answer ?? question.status,
      meetingId: question.meetingId,
      tags: [question.status],
    });
  }
  for (const idea of dataset.ideas) {
    items.push({
      id: `idea:${idea.id}`,
      kind: 'idea',
      title: idea.text,
      body: idea.status,
      meetingId: idea.meetingId,
      tags: [idea.status],
    });
  }
  for (const commitment of dataset.commitments) {
    items.push({
      id: `commitment:${commitment.id}`,
      kind: 'commitment',
      title: commitment.text,
      body: commitment.status,
      meetingId: commitment.meetingId,
      tags: [commitment.status],
    });
  }
  return items;
}

export function buildAskAnswer(
  dataset: DemoDataset,
  question: string,
  generatedAt?: string,
): AskAiAnswer {
  const trimmed = question.trim();
  const known = demoKnownQuestions.find(
    (entry) => normalizeText(entry.question) === normalizeText(trimmed),
  );
  if (known) {
    const citations = known.cites.map((ref) => {
      const citation = citationFor(dataset, ref);
      if (!citation)
        throw new Error(`demo Ask AI: citation ${ref} no longer resolves — fix the known answer`);
      return citation;
    });
    return {
      id: `ask_known_${known.cites.join('_').slice(0, 40)}`,
      question: trimmed,
      answer: known.answer,
      citations,
      adapter: 'demo_fixtures',
      generatedAt: generatedAt ?? dataset.generatedAt,
      matchedKnownQuestion: true,
      notes: [
        'Answer assembled from this workspace’s demo fixtures — decisions, tasks and facts, each linked to its transcript evidence.',
      ],
    };
  }

  const matches = retrieve(trimmed, retrievableItems(dataset), { limit: 6 });
  if (matches.length === 0) {
    return {
      id: 'ask_empty',
      question: trimmed,
      answer: [
        'Nothing in this workspace’s demo corpus matches that wording, so there is no answer to give. In the real product this is where retrieval reports coverage honestly instead of guessing.',
      ],
      citations: [],
      adapter: 'demo_fixtures',
      generatedAt: generatedAt ?? dataset.generatedAt,
      matchedKnownQuestion: false,
      notes: [
        'Try a question about a specific company, decision, owner or metric — the demo corpus covers Foodera, Nomad Education and Chirchik Textile.',
      ],
    };
  }

  const citations = matches
    .map((match) => citationFor(dataset, match.item.id))
    .filter((citation): citation is AskAiCitation => citation !== null);

  const perMeeting = new Map<string, number>();
  for (const match of matches)
    perMeeting.set(match.item.meetingId, (perMeeting.get(match.item.meetingId) ?? 0) + 1);
  const meetingNames = [...perMeeting.keys()]
    .map((id) => dataset.meetings.find((meeting) => meeting.id === id)?.title ?? 'Unknown meeting')
    .slice(0, 3);

  return {
    id: `ask_${matches
      .map((match) => match.item.id.replace(/[^a-z0-9]/gi, ''))
      .join('_')
      .slice(0, 48)}`,
    question: trimmed,
    answer: [
      `Retrieved ${matches.length} record${matches.length === 1 ? '' : 's'} from ${meetingNames.length} meeting${meetingNames.length === 1 ? '' : 's'}: ${meetingNames.join('; ')}.`,
      ...matches.map(
        (match) =>
          `${match.item.kind} · ${match.item.title}${
            match.item.kind === 'task' || match.item.kind === 'fact'
              ? ` — ${match.item.body.trim()}`
              : ''
          }`,
      ),
    ],
    citations,
    adapter: 'demo_fixtures',
    generatedAt: generatedAt ?? dataset.generatedAt,
    matchedKnownQuestion: false,
    notes: [
      'This is deterministic retrieval over demo fixtures, ranked by word overlap — no model call was made, and nothing beyond these records is claimed.',
    ],
  };
}

export const demoAskSuggestions = [
  'Foodera bilan budget haqida nima kelishganmiz?',
  'Akmal zimmasida qanday vazifalar qolgan?',
  'Oxirgi oy marketing bo‘yicha qanday qarorlar bo‘lgan?',
  'Clientning objectionlarini chiqar.',
  'What is still unresolved about our revenue numbers?',
  'Which deadlines are overdue?',
];

/** Timestamp range as the UI renders it, so a citation reads exactly like a transcript row. */
export function citationRange(citation: AskAiCitation): string {
  return `${formatTimestamp(citation.startMs)} – ${formatTimestamp(citation.endMs)}`;
}
