import { meeting } from './ids';

/**
 * Demo fixtures cite transcript **line ranges** rather than segment ids or timestamps.
 *
 * The dataset builder turns a range into `{ segmentIds, startMs, endMs, speakers, quote }` using the same
 * segments the transcript view renders, so an evidence reference cannot point at a line that does not exist
 * and cannot claim a time range the audio does not cover. `integrity.ts` still verifies the result — the
 * builder is not trusted on assertion alone.
 */
export type LineRange = readonly [from: number, to: number];

export type MeetingKey =
  | 'fooderaMarketing'
  | 'fooderaCrmSync'
  | 'nomadPipeline'
  | 'chirchikExport'
  | 'boardQ4'
  | 'fooderaCreative';

/** Derived from `ids.ts`, so the two files cannot drift apart. */
export const MEETING_ID_BY_KEY: Record<MeetingKey, string> = {
  fooderaMarketing: meeting.fooderaMarketing,
  fooderaCrmSync: meeting.fooderaCrmSync,
  nomadPipeline: meeting.nomadPipeline,
  chirchikExport: meeting.chirchikExport,
  boardQ4: meeting.boardQ4,
  fooderaCreative: meeting.fooderaCreative,
};
