import { describe, expect, it } from 'vitest';

import {
  archiveStaleBlockedWorkerSessions,
  buildRetryPrompt,
  continueCountForTicket,
} from '../src/workflow/ticket_runtime.js';
import type { SessionMap } from '../src/automation/session_dispatcher.js';

function baseMap(): SessionMap {
  return {
    version: 1,
    sessionsByTicket: {},
  };
}

describe('ticket_runtime helpers', () => {
  it('returns continue count when present and positive', () => {
    const map = baseMap();
    map.sessionsByTicket.T1 = {
      sessionId: 't1',
      lastState: 'in_progress',
      lastSeenAt: '2026-03-01T00:00:00.000Z',
      continueCount: 2,
    };
    expect(continueCountForTicket(map, 'T1')).toBe(2);
  });

  it('returns zero continue count for missing or invalid values', () => {
    const map = baseMap();
    map.sessionsByTicket.T2 = {
      sessionId: 't2',
      lastState: 'in_progress',
      lastSeenAt: '2026-03-01T00:00:00.000Z',
      continueCount: -1,
    };
    expect(continueCountForTicket(map, 'missing')).toBe(0);
    expect(continueCountForTicket(map, 'T2')).toBe(0);
  });

  it('formats retry prompt with all missing fields', () => {
    const prompt = buildRetryPrompt(['verification_evidence', 'resolved_blockers']);
    expect(prompt).toContain('Missing items: verification_evidence, resolved_blockers');
    expect(prompt).toContain('Reply with markdown report only');
  });

  it('archives stale blocked sessions and clears active ticket when needed', () => {
    const map = baseMap();
    map.sessionsByTicket.OLD = {
      sessionId: 'old',
      lastState: 'blocked',
      lastSeenAt: '2026-02-01T00:00:00.000Z',
    };
    map.sessionsByTicket.RECENT = {
      sessionId: 'recent',
      lastState: 'blocked',
      lastSeenAt: '2026-03-08T00:00:00.000Z',
    };
    map.active = { ticketId: 'OLD', sessionId: 'old' };

    archiveStaleBlockedWorkerSessions(map, new Date('2026-03-10T00:00:00.000Z'), 7);

    expect(map.sessionsByTicket.OLD).toBeUndefined();
    expect(map.active).toBeUndefined();
    expect(map.sessionsByTicket.RECENT).toBeDefined();
  });
});
