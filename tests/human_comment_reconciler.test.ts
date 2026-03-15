import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadSessionMap,
  saveSessionMap,
} = vi.hoisted(() => ({
  loadSessionMap: vi.fn(async () => ({
    version: 1 as const,
    sessionsByTicket: {
      A1: {
        sessionId: 'a1',
        lastState: 'blocked' as const,
        lastSeenAt: '2026-03-15T16:00:00.000Z',
        workStartedAt: '2026-03-15T15:00:00.000Z',
      },
    },
  })),
  saveSessionMap: vi.fn(async () => undefined),
}));

vi.mock('../src/automation/session_dispatcher.js', async () => {
  const actual = await vi.importActual<typeof import('../src/automation/session_dispatcher.js')>('../src/automation/session_dispatcher.js');
  return {
    ...actual,
    loadSessionMap,
    saveSessionMap,
  };
});

import { runHumanCommentReconciler } from '../src/workflow/human_comment_reconciler.js';

function cursorPath(name: string): string {
  return `.tmp/${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

describe('human_comment_reconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requeues a blocked ticket immediately when the requested human comment is valid', async () => {
    const adapter = {
      getWorkItem: vi.fn(async () => ({ id: 'A1', stage: 'stage:blocked' as const })),
      whoami: vi.fn(async () => ({ id: 'bot-1', username: 'kwf-bot', name: 'Jules Mercer' })),
      listComments: vi.fn(async () => [
        {
          id: 'c-human-1',
          body: 'The dependency is ready now.',
          author: { id: 'human-1', username: 'alice' },
        },
        {
          id: 'c-worker-1',
          body: 'Worker decision: blocked\n\nBlocker resolve requests:\n1. Need the dependency provisioned.',
          author: { id: 'bot-1', username: 'kwf-bot', name: 'Jules Mercer' },
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const result = await runHumanCommentReconciler({
      adapter,
      ticketId: 'A1',
      commentId: 'c-human-1',
      cursorPath: cursorPath('kwf-human-comment-reconciler'),
    });

    expect(result.quiet).toBe(false);
    if (result.quiet) return;
    expect(adapter.setStage).toHaveBeenCalledWith('A1', 'stage:todo');
    expect(result.payload.humanCommentReconcile.actions).toEqual([
      { ticketId: 'A1', fromStage: 'stage:blocked', toStage: 'stage:todo', triggerCommentId: 'c-human-1' },
    ]);
    expect(saveSessionMap.mock.calls.length).toBeGreaterThanOrEqual(1);
    const persistedMap = ((saveSessionMap.mock.calls as unknown as Array<[any]>).at(-1)?.[0]);
    expect(persistedMap.sessionsByTicket.A1.lastState).toBe('queued');
  });

  it('does nothing when the ticket is not in a reopenable stage', async () => {
    const adapter = {
      getWorkItem: vi.fn(async () => ({ id: 'A1', stage: 'stage:todo' as const })),
      whoami: vi.fn(async () => ({ username: 'kwf-bot' })),
      listComments: vi.fn(async () => []),
      setStage: vi.fn(async () => undefined),
    };

    const result = await runHumanCommentReconciler({
      adapter,
      ticketId: 'A1',
      commentId: 'c-human-1',
    });

    expect(result).toEqual({ quiet: true, exitCode: 0, reason: 'not_reopenable_stage' });
    expect(saveSessionMap).not.toHaveBeenCalled();
  });
});
