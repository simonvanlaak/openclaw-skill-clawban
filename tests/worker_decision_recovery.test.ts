import { describe, expect, it, vi } from 'vitest';

import { recoverWorkerDecisionFromComments } from '../src/workflow/worker_decision_recovery.js';

describe('worker_decision_recovery', () => {
  it('heals an in-progress ticket from a fresh completed worker decision comment', async () => {
    const map = {
      version: 1 as const,
      active: { ticketId: 'A1', sessionId: 'jules-237' },
      sessionsByTicket: {
        A1: {
          sessionId: 'jules-237',
          lastState: 'in_progress' as const,
          lastSeenAt: '2026-03-15T16:07:28.627Z',
          workStartedAt: '2026-03-15T16:07:28.627Z',
        },
      },
    };

    const adapter = {
      setStage: vi.fn(async () => undefined),
    };
    const onCompleted = vi.fn();

    const recovered = await recoverWorkerDecisionFromComments({
      adapter,
      map,
      output: {
        tick: { kind: 'in_progress', id: 'A1', inProgressIds: ['A1'] },
        nextTicket: {
          item: { id: 'A1', title: 'Ticket' },
          comments: [
            {
              id: 'c-1',
              body: 'Worker decision: completed\n\nSolution summary:\n- Fixed it',
              createdAt: new Date('2026-03-15T16:17:00.000Z'),
            },
          ],
        },
        dryRun: false,
      },
      action: { ticketId: 'A1', sessionId: 'jules-237' },
      onCompleted,
    });

    expect(recovered?.outcome).toBe('applied');
    expect(recovered?.detail).toContain('source=worker-decision-comment-recovery');
    expect(adapter.setStage).toHaveBeenCalledWith('A1', 'stage:in-review');
    expect(map.active).toBeUndefined();
    expect(map.sessionsByTicket.A1.lastState).toBe('completed');
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it('ignores stale worker decision comments from before the current work attempt', async () => {
    const map = {
      version: 1 as const,
      active: { ticketId: 'A1', sessionId: 'jules-237' },
      sessionsByTicket: {
        A1: {
          sessionId: 'jules-237',
          lastState: 'in_progress' as const,
          lastSeenAt: '2026-03-15T16:07:28.627Z',
          workStartedAt: '2026-03-15T16:07:28.627Z',
        },
      },
    };

    const adapter = {
      setStage: vi.fn(async () => undefined),
    };

    const recovered = await recoverWorkerDecisionFromComments({
      adapter,
      map,
      output: {
        tick: { kind: 'in_progress', id: 'A1', inProgressIds: ['A1'] },
        nextTicket: {
          item: { id: 'A1', title: 'Ticket' },
          comments: [
            {
              id: 'c-older',
              body: 'Worker decision: blocked\n\nBlocker resolve requests:\n1. Need input',
              createdAt: new Date('2026-03-15T16:00:00.000Z'),
            },
          ],
        },
        dryRun: false,
      },
      action: { ticketId: 'A1', sessionId: 'jules-237' },
    });

    expect(recovered).toBeNull();
    expect(adapter.setStage).not.toHaveBeenCalled();
    expect(map.active).toEqual({ ticketId: 'A1', sessionId: 'jules-237' });
    expect(map.sessionsByTicket.A1.lastState).toBe('in_progress');
  });
});
