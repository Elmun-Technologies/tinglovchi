import { z } from 'zod';

/**
 * One recorded conversation in the one-button flow (`/yoz`): the audio, its transcript and the AI analysis.
 *
 * Kept deliberately separate from the workspace/meeting model: this flow needs no account, workspace or
 * worker, only a place on disk, a transcription key and an Anthropic key.
 */

export const sessionStatusSchema = z.enum([
  'uploaded',
  'transcribing',
  'analyzing',
  'ready',
  'failed',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const utteranceSchema = z.object({
  speaker: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
});
export type Utterance = z.infer<typeof utteranceSchema>;

export const transcriptSchema = z.object({
  provider: z.string(),
  languageCode: z.string().nullable(),
  durationMs: z.number().nonnegative(),
  utterances: z.array(utteranceSchema),
});
export type Transcript = z.infer<typeof transcriptSchema>;

/**
 * What the model returns. Every field is required and nullable rather than optional so the schema stays
 * valid for structured outputs; numbers and talk time are computed from the transcript, never by the model.
 */
export const analysisSchema = z.object({
  title: z.string().describe('Suhbatning qisqa nomi, 3-8 so‘z'),
  conversationType: z
    .string()
    .describe('Masalan: mijoz bilan birinchi uchrashuv, brif, hisobot, ichki yig‘ilish'),
  summary: z.string().describe('3-6 gapdan iborat umumiy xulosa'),
  keyPoints: z.array(z.string()).describe('Eng muhim 3-8 ta fikr'),
  participants: z.array(
    z.object({
      speaker: z.string().describe('Transkriptdagi spiker belgisi, masalan A yoki B'),
      name: z.string().nullable().describe('Suhbatdan aniq bo‘lsa ism, aks holda null'),
      role: z
        .string()
        .nullable()
        .describe('Masalan: mijoz, agentlik menejeri; noma’lum bo‘lsa null'),
    }),
  ),
  topics: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      refs: z
        .array(z.number().int())
        .describe('Shu fikr aytilgan transkript qatorlari raqamlari (#), 1-3 ta'),
    }),
  ),
  decisions: z.array(
    z.object({
      text: z.string(),
      confirmed: z.boolean().describe('Aniq kelishilgan bo‘lsa true, faqat taklif bo‘lsa false'),
      refs: z
        .array(z.number().int())
        .describe('Shu fikr aytilgan transkript qatorlari raqamlari (#), 1-3 ta'),
    }),
  ),
  tasks: z.array(
    z.object({
      task: z.string(),
      owner: z.string().nullable().describe('Kim bajaradi; aytilmagan bo‘lsa null'),
      deadline: z.string().nullable().describe('Aytilgan muddat; aytilmagan bo‘lsa null'),
      refs: z
        .array(z.number().int())
        .describe('Shu fikr aytilgan transkript qatorlari raqamlari (#), 1-3 ta'),
    }),
  ),
  clientBrief: z.object({
    company: z.string().nullable(),
    product: z.string().nullable(),
    goals: z.array(z.string()),
    targetAudience: z.string().nullable(),
    budget: z.string().nullable(),
    kpis: z.array(z.string()),
    channels: z.array(z.string()),
    deadlines: z.array(z.string()),
    constraints: z.array(z.string()),
  }),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
  nextSteps: z.array(z.string()),
  mindMap: z.object({
    center: z.string(),
    branches: z.array(
      z.object({
        title: z.string(),
        children: z.array(z.string()),
      }),
    ),
  }),
  roadmap: z.array(
    z.object({
      phase: z.string(),
      timeframe: z.string().nullable(),
      items: z.array(z.string()),
    }),
  ),
  slides: z.array(
    z.object({
      title: z.string(),
      bullets: z.array(z.string()),
    }),
  ),
});
export type Analysis = z.infer<typeof analysisSchema>;

export const speakerStatSchema = z.object({
  speaker: z.string(),
  talkMs: z.number().nonnegative(),
  share: z.number().min(0).max(1),
  turns: z.number().int().nonnegative(),
});
export type SpeakerStat = z.infer<typeof speakerStatSchema>;

export const analysisLanguageSchema = z.enum(['uz', 'ru', 'en']);
export type AnalysisLanguage = z.infer<typeof analysisLanguageSchema>;

export const sessionSourceSchema = z.enum(['web', 'telegram']);
export type SessionSource = z.infer<typeof sessionSourceSchema>;

export const captureModeSchema = z.enum(['mic', 'mic_and_system', 'file']);
export type CaptureMode = z.infer<typeof captureModeSchema>;

/** What a session cost to process, for pricing decisions; estimated from the providers' list prices. */
export const usageSchema = z.object({
  audioSeconds: z.number().nonnegative(),
  transcriptionProvider: z.string(),
  transcriptionCostUsd: z.number().nonnegative().nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  analysisCostUsd: z.number().nonnegative().nullable(),
});
export type Usage = z.infer<typeof usageSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: sessionStatusSchema,
  title: z.string().nullable(),
  audioFile: z.string(),
  audioMimeType: z.string(),
  audioBytes: z.number().int().nonnegative(),
  recordedMs: z.number().nonnegative(),
  language: analysisLanguageSchema.default('uz'),
  captureMode: captureModeSchema.default('mic'),
  source: sessionSourceSchema.default('web'),
  /** The Telegram chat that sent the recording; the result is delivered back there. */
  telegramChatId: z.number().int().nullable().default(null),
  /** The transcription provider's job id, kept so a retry polls it instead of paying again. */
  providerJobId: z.string().nullable().default(null),
  transcript: transcriptSchema.nullable(),
  speakerStats: z.array(speakerStatSchema),
  analysis: analysisSchema.nullable(),
  usage: usageSchema.nullable().default(null),
  error: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
});
export type Session = z.infer<typeof sessionSchema>;

/** What the list endpoint returns: no transcript or analysis bodies. */
export type SessionSummary = Pick<
  Session,
  'id' | 'createdAt' | 'status' | 'title' | 'recordedMs' | 'error' | 'usage'
>;
