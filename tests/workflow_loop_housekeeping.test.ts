import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  maybeSendNoWorkFirstHitAlert,
  reconcileQueuePositionComments,
  maybeUpdateRocketChatStatusFromWorkflowLoop,
} = vi.hoisted(() => ({
  maybeSendNoWorkFirstHitAlert: vi.fn(async () => null),
  reconcileQueuePositionComments: vi.fn(async () => ({
    outcome: 'applied',
    queuedTickets: 0,
    activeOffset: 1,
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    errors: [],
  })),
  maybeUpdateRocketChatStatusFromWorkflowLoop: vi.fn(async () => null),
}));

vi.mock('../src/workflow/no_work_alert.js', () => ({
  maybeSendNoWorkFirstHitAlert,
}));

vi.mock('../src/workflow/queue_position_comments.js', () => ({
  reconcileQueuePositionComments,
}));

vi.mock('../src/workflow/rocketchat_status.js', () => ({
  maybeUpdateRocketChatStatusFromWorkflowLoop,
}));

import { runWorkflowLoopHousekeeping } from '../src/workflow/workflow_loop_housekeeping.js';

describe('workflow_loop_housekeeping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs housekeeping side effects without mutating active lifecycle state', async () => {
    const map = {
      version: 1 as const,
      active: { ticketId: 'A1', sessionId: 'a1' },
      sessionsByTicket: {
        A1: {
          sessionId: 'a1',
          lastState: 'in_progress' as const,
          lastSeenAt: '2026-03-15T16:00:00.000Z',
          workStartedAt: '2026-03-15T15:00:00.000Z',
        },
      },
    };

    const result = await runWorkflowLoopHousekeeping({
      adapter: {
        listBacklogIdsInOrder: vi.fn(async () => ['A2']),
        listComments: vi.fn(async () => []),
        addComment: vi.fn(async () => undefined),
        updateComment: vi.fn(async () => undefined),
        deleteComment: vi.fn(async () => undefined),
      },
      output: {
        tick: { kind: 'in_progress', id: 'A1', inProgressIds: ['A1'] },
        nextTicket: {
          adapter: 'plane',
          item: { id: 'A1', title: 'Current ticket', stage: 'stage:in-progress', labels: [] },
          comments: [],
        },
        dryRun: false,
      },
      previousMap: structuredClone(map),
      map,
      dryRun: false,
    });

    expect(result.queuePositionUpdate?.outcome).toBe('applied');
    expect(map.active).toEqual({ ticketId: 'A1', sessionId: 'a1' });
    expect(map.sessionsByTicket.A1?.lastState).toBe('in_progress');
  });

  it('throws if housekeeping mutates the active lifecycle entry', async () => {
    maybeUpdateRocketChatStatusFromWorkflowLoop.mockImplementationOnce((async ({ map }: any) => {
      map.sessionsByTicket.A1.lastState = 'queued';
      return null;
    }) as any);

    const map = {
      version: 1 as const,
      active: { ticketId: 'A1', sessionId: 'a1' },
      sessionsByTicket: {
        A1: {
          sessionId: 'a1',
          lastState: 'in_progress' as const,
          lastSeenAt: '2026-03-15T16:00:00.000Z',
          workStartedAt: '2026-03-15T15:00:00.000Z',
        },
      },
    };

    await expect(
      runWorkflowLoopHousekeeping({
        adapter: {
          listBacklogIdsInOrder: vi.fn(async () => ['A2']),
          listComments: vi.fn(async () => []),
          addComment: vi.fn(async () => undefined),
          updateComment: vi.fn(async () => undefined),
          deleteComment: vi.fn(async () => undefined),
        },
        output: {
          tick: { kind: 'in_progress', id: 'A1', inProgressIds: ['A1'] },
          nextTicket: {
            adapter: 'plane',
            item: { id: 'A1', title: 'Current ticket', stage: 'stage:in-progress', labels: [] },
            comments: [],
          },
          dryRun: false,
        },
        previousMap: structuredClone(map),
        map,
        dryRun: false,
      }),
    ).rejects.toThrow('housekeeping mutated active ticket lifecycle entry');
  });
});
