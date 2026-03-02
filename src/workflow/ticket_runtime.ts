import type { SessionMap } from '../automation/session_dispatcher.js';

export function continueCountForTicket(map: SessionMap, ticketId: string): number {
  const entry = (map.sessionsByTicket ?? {})[ticketId] as any;
  const n = Number(entry?.continueCount ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function buildRetryPrompt(missing: string[]): string {
  return [
    'Your previous report is missing required elements.',
    `Missing items: ${missing.join(', ')}`,
    'Reply with markdown report only and include the missing items.',
  ].join('\n');
}

export function archiveStaleBlockedWorkerSessions(
  map: SessionMap,
  now: Date,
  inactivityDays = 7,
): void {
  const cutoffMs = now.getTime() - inactivityDays * 24 * 60 * 60 * 1000;
  for (const [ticketId, entry] of Object.entries(map.sessionsByTicket ?? {})) {
    if (entry?.lastState !== 'blocked') continue;
    const lastSeenMs = Date.parse(String(entry.lastSeenAt ?? ''));
    if (!Number.isFinite(lastSeenMs)) continue;
    if (lastSeenMs > cutoffMs) continue;
    delete map.sessionsByTicket[ticketId];
    if (map.active?.ticketId === ticketId) {
      map.active = undefined;
    }
  }
}
