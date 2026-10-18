import type { Analysis } from './types';

const COLORS = [
  '#0f766e',
  '#7c3aed',
  '#c2410c',
  '#2563eb',
  '#be123c',
  '#4d7c0f',
  '#0e7490',
  '#a16207',
];

export function speakerColor(speaker: string): string {
  const index = speaker.length === 1 ? speaker.charCodeAt(0) - 65 : speaker.length;
  return COLORS[((index % COLORS.length) + COLORS.length) % COLORS.length]!;
}

/** "Aziz (mijoz)", "Mijoz", or "Spiker A" when the conversation never said who it was. */
export function speakerName(speaker: string, analysis: Analysis | null): string {
  const participant = analysis?.participants.find((entry) => entry.speaker === speaker);
  if (participant?.name && participant.role) return `${participant.name} (${participant.role})`;
  return participant?.name ?? participant?.role ?? `Spiker ${speaker}`;
}
