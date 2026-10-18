/** `mm:ss`, or `h:mm:ss` from one hour on. Shared by the server prompt and the browser views. */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "1 soat 5 daqiqa", "12 daqiqa", "40 soniya". */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} soniya`;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} daqiqa`;
  return minutes === 0 ? `${hours} soat` : `${hours} soat ${minutes} daqiqa`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "$0.24" — costs are shown in dollars because the providers bill in dollars. */
export function formatUsd(value: number): string {
  return value < 0.01 && value > 0 ? '<$0.01' : `$${value.toFixed(2)}`;
}

export function totalCostUsd(
  usage: { transcriptionCostUsd: number | null; analysisCostUsd: number | null } | null,
): number | null {
  if (!usage) return null;
  if (usage.transcriptionCostUsd === null && usage.analysisCostUsd === null) return null;
  return (usage.transcriptionCostUsd ?? 0) + (usage.analysisCostUsd ?? 0);
}
