import { beforeEach, describe, expect, it, vi } from 'vitest';

const { saveSessionMap, dispatchWorkerTurn } = vi.hoisted(() => ({
  saveSessionMap: vi.fn(async () => undefined),
  dispatchWorkerTurn: vi.fn(async () => {
    throw new Error('gateway unavailable');
  }),
}));

vi.mock('../src/automation/session_dispatcher.js', async () => {
  const actual = await vi.importActual<typeof import('../src/automation/session_dispatcher.js')>('../src/automation/session_dispatcher.js');
  return {
    ...actual,
    saveSessionMap,
  };
});

vi.mock('../src/workflow/worker_runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../src/workflow/worker_runtime.js')>('../src/workflow/worker_runtime.js');
  return {
    ...actual,
    dispatchWorkerTurn,
    loadWorkerDelegationState: vi.fn(async () => ({ kind: 'none' })),
  };
});

vi.mock('../src/workflow/no_work_alert.js', () => ({
  maybeSendNoWorkFirstHitAlert: vi.fn(async () => null),
}));

vi.mock('../src/workflow/rocketchat_status.js', () => ({
  maybeUpdateRocketChatStatusFromWorkflowLoop: vi.fn(async () => null),
}));

vi.mock('../src/workflow/queue_position_comments.js', () => ({
  reconcileQueuePositionComments: vi.fn(async () => ({
    outcome: 'applied',
    queuedTickets: 0,
    activeOffset: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    errors: [],
  })),
}));

import { runWorkflowLoopController } from '../src/workflow/workflow_loop_controller.js';

describe('workflow_loop_controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveSessionMap.mockResolvedValue(undefined);
    dispatchWorkerTurn.mockRejectedValue(new Error('gateway unavailable'));
  });

  it('persists reserved state before dispatching worker execution', async () => {
    const previousMap = { version: 1 as const, sessionsByTicket: {} };
    const output = {
      tick: { kind: 'started' as const, id: 'A1', reasonCode: 'start_next_assigned_backlog' },
      nextTicket: {
        item: {
          id: 'A1',
          title: 'Investigate workflow handoff races',
        },
        comments: [],
      },
      dryRun: false,
    };

    await expect(
      runWorkflowLoopController({
        adapter: {
          addComment: vi.fn(async () => undefined),
          setStage: vi.fn(async () => undefined),
          listBacklogIdsInOrder: vi.fn(async () => []),
          listComments: vi.fn(async () => []),
          updateComment: vi.fn(async () => undefined),
          deleteComment: vi.fn(async () => undefined),
        },
        output,
        previousMap,
        dryRun: false,
        dispatchRunId: 'dispatch-1',
        workerAgentId: 'kanban-workflow-worker',
        workerRuntimeOptions: {
          delegationDir: '.tmp/test-delegations',
          defaultSyncTimeoutMs: 30_000,
          defaultBackgroundTimeoutMs: 60_000,
          isBackgroundDelegationAllowed: () => false,
        },
      }),
    ).rejects.toThrow('gateway unavailable');

    expect(saveSessionMap).toHaveBeenCalledTimes(1);
    const persistedMap = (saveSessionMap.mock.calls[0] as any)?.[0];
    expect(persistedMap?.active).toEqual({ ticketId: 'A1', sessionId: 'a1' });
    expect(persistedMap?.sessionsByTicket?.A1?.lastState).toBe('reserved');
  });
});
