// Suhbat tahlili: Claude transkriptni o'qib, prezentatsiya uchun tuzilgan JSON qaytaradi.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.SUHBAT_CLAUDE_MODEL || 'claude-opus-5-5';

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const priority = { type: 'string', enum: ['P1', 'P2', 'P3'] };
const side = { type: 'string', enum: ['biz', 'mijoz', 'hamkor', 'nomalum'] };
const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const ANALYSIS_SCHEMA = obj({
  title: str,
  client: str,
  meeting_type: str,
  language: str,
  executive_summary: str,
  key_takeaways: strArr,
  participants: {
    type: 'array',
    items: obj({ name: str, side, role: str, speaker_labels: strArr }),
  },
  topics: {
    type: 'array',
    items: obj({ title: str, summary: str, points: strArr, time: str }),
  },
  requirements: {
    type: 'array',
    items: obj({ from: str, side, requirement: str, details: str, priority, time: str }),
  },
  deliverables: {
    type: 'array',
    items: obj({ from: str, to: str, item: str, deadline: str, priority, time: str }),
  },
  reviews: {
    type: 'array',
    items: obj({ who: str, what: str, deadline: str, time: str }),
  },
  tasks: {
    type: 'array',
    items: obj({
      title: str,
      owner: str,
      side,
      priority,
      deadline: str,
      details: str,
      time: str,
    }),
  },
  decisions: {
    type: 'array',
    items: obj({
      decision: str,
      status: { type: 'string', enum: ['kelishildi', 'taklif', 'ochiq'] },
      time: str,
    }),
  },
  open_questions: {
    type: 'array',
    items: obj({ question: str, who_answers: str, time: str }),
  },
  risks: {
    type: 'array',
    items: obj({
      risk: str,
      impact: { type: 'string', enum: ['yuqori', 'orta', 'past'] },
      mitigation: str,
    }),
  },
  key_numbers: {
    type: 'array',
    items: obj({ label: str, value: str }),
  },
  roadmap: {
    type: 'array',
    items: obj({ phase: str, timeframe: str, goals: strArr, items: strArr }),
  },
  next_steps: strArr,
});

const SYSTEM = `Siz biznes uchrashuvlarini tahlil qiluvchi tajribali loyiha menejeri va biznes-tahlilchisiz.
Sizga mijoz bilan (yoki jamoa ichida) bo'lgan uzun og'zaki suhbatning avtomatik transkripti beriladi.
Vazifangiz — suhbatdan rahbar va jamoa darhol ishlata oladigan, prezentatsiyaga tayyor tahlil chiqarish.

Transkript haqida:
- Har bir qator: [SS:DD:ss] Qn/Sm: matn. Vaqt — suhbat boshidan.
- Qn — yozuv qismi raqami (har ~20 daqiqada yangi qism). Sm — shu qism ichidagi spiker raqami.
  Spiker raqamlari qismlar orasida mos KELMASLIGI mumkin (Q1/S1 va Q2/S1 boshqa odam bo'lishi mumkin).
  Odamlarni ismlari, murojaatlar ("Aziz aka", "Dilnoza opa"), lavozimi va gap mazmunidan aniqlang.
- Avtomatik transkripsiyada xatolar bo'ladi: o'zbek, rus va ingliz so'zlari aralash, ismlar buzilgan bo'lishi mumkin.
  Mazmunni kontekstdan tiklang, lekin yo'q narsani to'qimang.

Qoidalar:
- Butun javob O'ZBEK tilida (lotin yozuvida) bo'lsin. Brend, mahsulot va texnik atamalar asl ko'rinishida qolsin.
- "side": "biz" — bizning kompaniya/jamoa, "mijoz" — mijoz tomoni, "hamkor" — uchinchi tomon, "nomalum" — aniqlab bo'lmasa.
- Faqat suhbatda haqiqatan aytilgan narsalarni yozing. Egasi yoki muddat aytilmagan bo'lsa — "Belgilanmagan" deb yozing,
  taxmin qilmang. Taxminiy xulosa bo'lsa, buni matnda ochiq ayting ("taxminan", "aniqlashtirish kerak").
- "time" maydoni — shu fikr eng aniq aytilgan joyning vaqti (SS:DD:ss), topilmasa "".
- Prioritet: P1 — shoshilinch/muhim, loyihaga to'sqinlik qiladi yoki mijoz alohida ta'kidladi; P2 — muhim, lekin
  shoshilinch emas; P3 — keyinroq yoki "yaxshi bo'lardi" darajasida.
- requirements — kim (qaysi tomon, kim) nimani talab qildi/kutyapti. Har ikki tomonning talablari ham.
- deliverables — kim kimga nimani YUBORISHI/topshirishi kerak (hujjat, fayl, kirish huquqi, narx taklifi, maket...).
- reviews — kim nimani KO'RIB CHIQISHI, tasdiqlashi yoki fikr bildirishi kerak.
- tasks — aniq bajariladigan ishlar, fe'l bilan boshlansin ("Tayyorlash...", "Yuborish..."), muhimlik bo'yicha tartiblang.
- topics — 4–8 ta asosiy mavzu, har biriga 2–5 ta qisqa nuqta (mind map uchun, har bir nuqta 8 so'zdan oshmasin).
- key_takeaways — "suhbatdan nima anglashildi": 4–8 ta eng muhim xulosa.
- roadmap — kelishilgan yoki mantiqan kelib chiqadigan bosqichlar (2–6 ta), vaqt oralig'i bilan.
- next_steps — keyingi 1–2 haftada qilinadigan eng muhim 3–7 qadam.
- key_numbers — byudjet, narxlar, sanalar, KPI, hajmlar kabi aytilgan raqamlar.
- Agar biror bo'lim bo'yicha ma'lumot bo'lmasa, bo'sh massiv qaytaring.
- title — suhbatning qisqa, aniq nomi (masalan: "Foodera bilan SMM strategiyasi bo'yicha uchrashuv").`;

function contextBlock(settings, meeting) {
  const lines = [];
  if (settings.companyName) lines.push(`Bizning kompaniya: ${settings.companyName}`);
  if (settings.teamMembers) lines.push(`Bizning jamoa a'zolari: ${settings.teamMembers}`);
  if (meeting.note) lines.push(`Suhbat haqida izoh: ${meeting.note}`);
  lines.push(`Sana: ${new Date(meeting.createdAt).toLocaleDateString('uz-UZ')}`);
  lines.push(`Davomiyligi: ${Math.round((meeting.durationMs || 0) / 60000)} daqiqa`);
  return lines.join('\n');
}

// Juda uzun transkriptlar (taxminan 10+ soat) uchun avval qismlab qisqacha qaydlar olinadi.
const MAX_SINGLE_PASS_CHARS = 1_400_000;
const PART_CHARS = 500_000;

/**
 * @param {{transcriptText: string, settings: object, meeting: object, onProgress?: (msg:string)=>void}} args
 */
export async function analyzeTranscript({
  transcriptText,
  settings,
  meeting,
  onProgress = () => {},
}) {
  if (!settings.anthropicApiKey) {
    const err = new Error('Anthropic (Claude) API kaliti kiritilmagan (Sozlamalar).');
    err.retryable = false;
    throw err;
  }
  const client = new Anthropic({
    apiKey: settings.anthropicApiKey,
    maxRetries: 4,
    timeout: 30 * 60 * 1000,
  });

  let material = transcriptText;
  let materialLabel = 'TRANSKRIPT';
  if (transcriptText.length > MAX_SINGLE_PASS_CHARS) {
    const parts = splitByLines(transcriptText, PART_CHARS);
    const notes = [];
    for (let i = 0; i < parts.length; i++) {
      onProgress(`Uzun suhbat: ${i + 1}/${parts.length}-qism o'qilmoqda`);
      notes.push(await summarizePart(client, parts[i], i + 1, parts.length));
    }
    material = notes.join('\n\n');
    materialLabel = 'QISMLAR BO‘YICHA BATAFSIL QAYDLAR';
  }

  onProgress('Claude suhbatni tahlil qilmoqda');
  const userContent = `${contextBlock(settings, meeting)}\n\n<${materialLabel}>\n${material}\n</${materialLabel}>\n\nYuqoridagi suhbatni qoidalarga muvofiq tahlil qiling.`;
  let message;
  try {
    message = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      })
      .finalMessage();
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    // Zaxira yo'l: agar API qat'iy JSON-sxema yoki beta parametrlarini qabul qilmasa,
    // sxemani ko'rsatma ichida berib, oddiy so'rov yuboramiz.
    console.warn('Tuzilgan javob rejimi rad etildi, oddiy rejimga o‘tildi:', err.message);
    onProgress('Claude suhbatni tahlil qilmoqda (zaxira rejim)');
    message = await client.messages
      .stream({
        model: MODEL,
        max_tokens: 64000,
        system: `${SYSTEM}\n\nJavobni FAQAT bitta JSON obyekt ko'rinishida qaytaring (izohsiz, markdown belgilarisiz). JSON quyidagi JSON Schema'ga to'liq mos bo'lsin:\n${JSON.stringify(ANALYSIS_SCHEMA)}`,
        messages: [{ role: 'user', content: userContent }],
      })
      .finalMessage();
  }
  if (message.stop_reason === 'refusal') {
    const err = new Error('Claude bu suhbatni tahlil qilishdan bosh tortdi.');
    err.retryable = false;
    throw err;
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('Tahlil javobi juda uzun bo‘lib ketdi va kesildi. Qayta urinib ko‘ring.');
  }
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const analysis = normalizeAnalysis(parseJsonObject(text));
  analysis._model = message.model;
  analysis._usage = message.usage;
  return analysis;
}

function parseJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new Error('Claude javobi kutilgan formatda emas. Qayta urinib ko‘ring.');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('Claude javobi kutilgan formatda emas. Qayta urinib ko‘ring.');
  }
}

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const text = (v) => (v === null || v === undefined ? '' : String(v));

/** Tahlil natijasini prezentatsiya kutgan shaklga keltiradi (yetishmagan maydonlar, noto'g'ri qiymatlar). */
export function normalizeAnalysis(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const strings = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);
  const pri = (v) => oneOf(v, ['P1', 'P2', 'P3'], 'P2');
  const sd = (v) => oneOf(v, ['biz', 'mijoz', 'hamkor', 'nomalum'], 'nomalum');
  return {
    title: text(a.title) || 'Suhbat tahlili',
    client: text(a.client),
    meeting_type: text(a.meeting_type),
    language: text(a.language),
    executive_summary: text(a.executive_summary),
    key_takeaways: strings(a.key_takeaways),
    participants: list(a.participants).map((p) => ({
      name: text(p.name),
      side: sd(p.side),
      role: text(p.role),
      speaker_labels: strings(p.speaker_labels),
    })),
    topics: list(a.topics).map((t) => ({
      title: text(t.title),
      summary: text(t.summary),
      points: strings(t.points),
      time: text(t.time),
    })),
    requirements: list(a.requirements).map((r) => ({
      from: text(r.from),
      side: sd(r.side),
      requirement: text(r.requirement),
      details: text(r.details),
      priority: pri(r.priority),
      time: text(r.time),
    })),
    deliverables: list(a.deliverables).map((d) => ({
      from: text(d.from),
      to: text(d.to),
      item: text(d.item),
      deadline: text(d.deadline) || 'Belgilanmagan',
      priority: pri(d.priority),
      time: text(d.time),
    })),
    reviews: list(a.reviews).map((r) => ({
      who: text(r.who),
      what: text(r.what),
      deadline: text(r.deadline) || 'Belgilanmagan',
      time: text(r.time),
    })),
    tasks: list(a.tasks).map((t) => ({
      title: text(t.title),
      owner: text(t.owner) || 'Belgilanmagan',
      side: sd(t.side),
      priority: pri(t.priority),
      deadline: text(t.deadline) || 'Belgilanmagan',
      details: text(t.details),
      time: text(t.time),
    })),
    decisions: list(a.decisions).map((d) => ({
      decision: text(d.decision),
      status: oneOf(d.status, ['kelishildi', 'taklif', 'ochiq'], 'ochiq'),
      time: text(d.time),
    })),
    open_questions: list(a.open_questions).map((q) => ({
      question: text(q.question),
      who_answers: text(q.who_answers),
      time: text(q.time),
    })),
    risks: list(a.risks).map((r) => ({
      risk: text(r.risk),
      impact: oneOf(r.impact, ['yuqori', 'orta', 'past'], 'orta'),
      mitigation: text(r.mitigation),
    })),
    key_numbers: list(a.key_numbers).map((n) => ({ label: text(n.label), value: text(n.value) })),
    roadmap: list(a.roadmap).map((p) => ({
      phase: text(p.phase),
      timeframe: text(p.timeframe),
      goals: strings(p.goals),
      items: strings(p.items),
    })),
    next_steps: strings(a.next_steps),
  };
}

/** Kalit, model va balansni juda qisqa haqiqiy so'rov bilan tekshiradi. */
export async function checkAnthropic(apiKey) {
  if (!apiKey) return { ok: false, message: 'Kalit kiritilmagan' };
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60 * 1000 });
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Faqat "ok" deb javob bering.' }],
    });
    return { ok: true, message: `Ulandi (model: ${msg.model})` };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError)
      return { ok: false, message: 'Kalit noto‘g‘ri (401).' };
    if (err instanceof Anthropic.PermissionDeniedError)
      return { ok: false, message: 'Bu kalitda ruxsat yo‘q (403).' };
    if (err instanceof Anthropic.NotFoundError)
      return { ok: false, message: `Model topilmadi: ${MODEL}` };
    if (err instanceof Anthropic.RateLimitError)
      return { ok: false, message: 'Limit to‘lgan yoki balans yetarli emas (429).' };
    if (err instanceof Anthropic.APIConnectionError)
      return { ok: false, message: 'Internet aloqasi yo‘q.' };
    if (err instanceof Anthropic.APIError)
      return { ok: false, message: `Xato ${err.status}: ${err.message}` };
    return { ok: false, message: String(err?.message || err) };
  }
}

async function summarizePart(client, part, index, total) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    output_config: { effort: 'medium' },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Bu uzun suhbatning ${index}/${total}-qismi.\n<TRANSKRIPT_QISMI>\n${part}\n</TRANSKRIPT_QISMI>\n\nBu qism bo'yicha batafsil qaydlar yozing (o'zbek tilida, oddiy matn): ishtirokchilar va ularning tomoni, muhokama qilingan mavzular, talablar (kim talab qildi), kim kimga nima yuborishi, kim nimani ko'rib chiqishi, vazifalar (egasi, muddati), qarorlar, ochiq savollar, risklar, raqamlar. Har bir muhim fikr yoniga vaqtini [SS:DD:ss] yozing. Hech narsani tashlab ketmang.`,
      },
    ],
  });
  const msg = await stream.finalMessage();
  return (
    `### ${index}-qism qaydlari\n` +
    msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
  );
}

function splitByLines(text, maxChars) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > maxChars && cur) {
      parts.push(cur);
      cur = '';
    }
    cur += line + '\n';
  }
  if (cur) parts.push(cur);
  return parts;
}
