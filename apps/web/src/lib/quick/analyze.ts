import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { formatTimestamp } from './format';
import { fakeAiEnabled } from './transcribe';
import { analysisSchema, type Analysis, type SpeakerStat, type Transcript } from './types';

/**
 * Turns a diarized transcript into the analysis shown after a recording: summary, topics, decisions, tasks,
 * client brief, mind map, roadmap and presentation slides. One structured-output call to Claude.
 */

export class AnalysisError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AnalysisError';
  }
}

export function analysisModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5-5';
}

export function missingAnalysisConfig(): string[] {
  if (fakeAiEnabled()) return [];
  return process.env.ANTHROPIC_API_KEY?.trim() ? [] : ['ANTHROPIC_API_KEY'];
}

const SYSTEM_PROMPT = `Sen marketing agentligining yordamchisisan. Agentlik xodimlari mijozlar bilan ko‘p uchrashadi va har bir suhbatni eslab qolish imkoni yo‘q. Senga bitta suhbatning to‘liq transkripti beriladi (spikerlar A, B, C... deb belgilangan; transkript avtomatik, shuning uchun ayrim so‘zlar noto‘g‘ri tanilgan bo‘lishi mumkin).

Vazifang — suhbatni tahlil qilib, agentlik jamoasi keyin ishlata oladigan aniq natija chiqarish:
- Barcha matnni o‘zbek tilida (lotin yozuvida) yoz, suhbat qaysi tilda bo‘lishidan qat’i nazar. Brend, mahsulot va kishi ismlarini asl holicha qoldir.
- Faqat suhbatda aytilgan narsalarni yoz. Hech narsa o‘ylab topma: aytilmagan ism, muddat, byudjet yoki raqam o‘rniga null yoki bo‘sh ro‘yxat qo‘y.
- Qarorlarda aniq kelishilganini (confirmed: true) shunchaki taklif yoki muhokamadan (confirmed: false) ajrat.
- Vazifalarda kim bajarishi va muddati faqat aniq aytilgan bo‘lsa yozilsin.
- clientBrief — mijoz haqida agentlikka kerakli ma’lumotlar (kompaniya, mahsulot, maqsadlar, auditoriya, byudjet, KPI, kanallar, muddatlar, cheklovlar). Suhbat mijoz bilan bo‘lmasa ham, borini to‘ldir.
- mindMap — markazda suhbatning asosiy mavzusi, 3-7 ta shox, har birida 2-6 ta qisqa band.
- roadmap — suhbatdan kelib chiqadigan keyingi ishlar bosqichlari (2-6 bosqich), vaqt aytilgan bo‘lsa timeframe bilan.
- slides — jamoa yoki mijozga ko‘rsatiladigan 5-9 slayddan iborat prezentatsiya: asosiy mavzular, mijoz ehtiyojlari, qarorlar, vazifalar, risklar, keyingi qadamlar. Sarlavha slaydi va «suhbat haqida» (sana, davomiylik, ishtirokchilar) slaydi avtomatik qo‘shiladi — ularni yozma. Har slaydda 3-6 ta qisqa band.
- Qisqa va aniq yoz; umumiy, hech narsa bildirmaydigan gaplardan qoch.`;

export function transcriptForPrompt(transcript: Transcript, stats: SpeakerStat[]): string {
  const header = [
    `Davomiyligi: ${formatTimestamp(transcript.durationMs)}`,
    `Aniqlangan til: ${transcript.languageCode ?? 'noma’lum'}`,
    `Spikerlar: ${stats.map((stat) => `${stat.speaker} (${Math.round(stat.share * 100)}%)`).join(', ')}`,
  ].join('\n');
  const body = transcript.utterances
    .map(
      (utterance) =>
        `[${formatTimestamp(utterance.startMs)}] ${utterance.speaker}: ${utterance.text}`,
    )
    .join('\n');
  return `${header}\n\n<transkript>\n${body}\n</transkript>`;
}

export async function analyzeTranscript(
  transcript: Transcript,
  stats: SpeakerStat[],
): Promise<Analysis> {
  if (fakeAiEnabled()) return fakeAnalysis();
  if (transcript.utterances.length === 0) {
    throw new AnalysisError(
      'Yozuvda nutq topilmadi — mikrofon ovozni yozmagan bo‘lishi mumkin.',
      false,
    );
  }

  const client = new Anthropic();
  let response;
  try {
    response = await client.beta.messages.parse({
      model: analysisModel(),
      max_tokens: 16000,
      output_config: { effort: 'high', format: betaZodOutputFormat(analysisSchema) },
      // On a policy decline the API re-runs the request on its default fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcriptForPrompt(transcript, stats) }],
    });
  } catch (cause) {
    if (cause instanceof Anthropic.AuthenticationError) {
      throw new AnalysisError('ANTHROPIC_API_KEY noto‘g‘ri.', false);
    }
    if (cause instanceof Anthropic.BadRequestError) {
      throw new AnalysisError(`Claude so‘rovni qabul qilmadi: ${cause.message}`, false);
    }
    if (cause instanceof Anthropic.APIError) {
      throw new AnalysisError(`Claude API xatosi: ${cause.message}`, true);
    }
    throw new AnalysisError(cause instanceof Error ? cause.message : String(cause), true);
  }

  if (response.stop_reason === 'refusal') {
    throw new AnalysisError('Claude bu suhbatni tahlil qilishdan bosh tortdi.', false);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new AnalysisError('Tahlil javobi juda uzun bo‘lib ketdi va kesildi.', true);
  }
  if (!response.parsed_output) {
    throw new AnalysisError('Claude javobini o‘qib bo‘lmadi.', true);
  }
  return response.parsed_output;
}

function fakeAnalysis(): Analysis {
  return {
    title: 'Instagram va Telegram kampaniyasi',
    conversationType: 'Mijoz bilan brif uchrashuvi',
    summary:
      'Mijoz Instagram va Telegram orqali sotuvni oshirmoqchi. Oylik byudjet taxminan 20 million so‘m, birinchi natija bir oyda kutilmoqda. Agentlik juma kunigacha taklif yuboradi.',
    keyPoints: [
      'Asosiy kanallar: Instagram va Telegram',
      'Oylik byudjet ~20 mln so‘m',
      'Birinchi natija — 1 oyda',
    ],
    participants: [
      { speaker: 'A', name: null, role: 'Agentlik menejeri' },
      { speaker: 'B', name: null, role: 'Mijoz' },
    ],
    topics: [
      { title: 'Maqsad', summary: 'Ijtimoiy tarmoqlar orqali sotuvni oshirish.' },
      { title: 'Byudjet va muddat', summary: 'Oyiga ~20 mln so‘m, natija bir oyda.' },
    ],
    decisions: [{ text: 'Birinchi haftada kontent-reja va target sozlanadi', confirmed: true }],
    tasks: [{ task: 'Taklif tayyorlab yuborish', owner: 'Agentlik', deadline: 'Juma' }],
    clientBrief: {
      company: null,
      product: null,
      goals: ['Sotuvni oshirish'],
      targetAudience: null,
      budget: '~20 mln so‘m / oy',
      kpis: [],
      channels: ['Instagram', 'Telegram'],
      deadlines: ['Taklif — juma', 'Birinchi natija — 1 oy'],
      constraints: [],
    },
    risks: ['KPI aniq belgilanmagan'],
    openQuestions: ['Maqsadli auditoriya kim?', 'Qaysi KPI bo‘yicha natija o‘lchanadi?'],
    nextSteps: ['Juma kunigacha taklif yuborish', 'KPI’larni mijoz bilan kelishish'],
    mindMap: {
      center: 'Sotuv kampaniyasi',
      branches: [
        { title: 'Kanallar', children: ['Instagram', 'Telegram'] },
        { title: 'Byudjet', children: ['~20 mln so‘m / oy'] },
        { title: 'Muddat', children: ['Taklif — juma', 'Natija — 1 oy'] },
      ],
    },
    roadmap: [
      { phase: 'Taklif', timeframe: 'Shu hafta', items: ['Taklif tayyorlash', 'Mijozga yuborish'] },
      { phase: 'Ishga tushirish', timeframe: '1-hafta', items: ['Kontent-reja', 'Target sozlash'] },
      { phase: 'Natija', timeframe: '1 oy', items: ['Sotuvlarni o‘lchash'] },
    ],
    slides: [
      { title: 'Asosiy mavzular', bullets: ['Kanallar: Instagram, Telegram', 'Byudjet va muddat'] },
      { title: 'Mijoz ehtiyojlari', bullets: ['Sotuvni oshirish', 'Natija 1 oyda'] },
      { title: 'Keyingi qadamlar', bullets: ['Juma — taklif', 'KPI’larni kelishish'] },
    ],
  };
}
