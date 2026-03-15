import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemDetails } from '../src/core/ports.js';

const { saveSessionMap, dispatchWorkerTurn } = vi.hoisted(() => ({
  saveSessionMap: vi.fn(async () => undefined),
  dispatchWorkerTurn: vi.fn(async () => {
    throw new Error('gateway unavailable');
  }),
}));
const { runWorkflowLoopSelection } = vi.hoisted(() => ({
  runWorkflowLoopSelection: vi.fn(),
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

vi.mock('../src/workflow/workflow_loop_selection.js', () => ({
  runWorkflowLoopSelection,
}));

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

function makeWorkItem(id: string, title: string): WorkItemDetails {
  return {
    id,
    title,
    stage: 'stage:todo',
    labels: [],
  };
}

describe('workflow_loop_controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveSessionMap.mockResolvedValue(undefined);
    dispatchWorkerTurn.mockRejectedValue(new Error('gateway unavailable'));
    runWorkflowLoopSelection.mockReset();
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
          name: vi.fn(() => 'plane'),
          whoami: vi.fn(async () => ({ id: 'me' })),
          listIdsByStage: vi.fn(async () => []),
          addComment: vi.fn(async () => undefined),
          setStage: vi.fn(async () => undefined),
          listBacklogIdsInOrder: vi.fn(async () => []),
          getWorkItem: vi.fn(async (id: string) => makeWorkItem(id, 'Investigate workflow handoff races')),
          listComments: vi.fn(async () => []),
          listAttachments: vi.fn(async () => []),
          listLinkedWorkItems: vi.fn(async () => []),
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

  it('heals a carried-forward ticket from a fresh worker decision comment without redispatching', async () => {
    const adapter = {
      name: vi.fn(() => 'plane'),
      whoami: vi.fn(async () => ({ id: 'me' })),
      listIdsByStage: vi.fn(async () => []),
      addComment: vi.fn(async () => undefined),
      setStage: vi.fn(async () => undefined),
      listBacklogIdsInOrder: vi.fn(async () => []),
      getWorkItem: vi.fn(async (id: string) => makeWorkItem(id, 'Investigate workflow handoff races')),
      listComments: vi.fn(async () => []),
      listAttachments: vi.fn(async () => []),
      listLinkedWorkItems: vi.fn(async () => []),
      updateComment: vi.fn(async () => undefined),
      deleteComment: vi.fn(async () => undefined),
    };

    const previousMap = {
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
    const output = {
      tick: { kind: 'in_progress' as const, id: 'A1', inProgressIds: ['A1'] },
      nextTicket: {
        item: {
          id: 'A1',
          title: 'Investigate workflow handoff races',
        },
        comments: [
          {
            id: 'c-1',
            body: 'Worker decision: completed\n\nSolution summary:\n- Fixed it',
            createdAt: new Date('2026-03-15T16:17:00.000Z'),
          },
        ],
      },
      dryRun: false,
    };

    const result = await runWorkflowLoopController({
      adapter,
      output,
      previousMap,
      dryRun: false,
      dispatchRunId: 'dispatch-2',
      workerAgentId: 'kanban-workflow-worker',
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        isBackgroundDelegationAllowed: () => false,
      },
    });

    expect(dispatchWorkerTurn).not.toHaveBeenCalled();
    expect(adapter.setStage).toHaveBeenCalledWith('A1', 'stage:in-review');
    expect(saveSessionMap).toHaveBeenCalledTimes(2);
    const persistedMap = (saveSessionMap.mock.calls[1] as any)?.[0];
    expect(persistedMap?.active).toBeUndefined();
    expect(persistedMap?.sessionsByTicket?.A1?.lastState).toBe('completed');
    expect(result.quiet).toBe(false);
    if (result.quiet) return;
    expect(result.payload.workflowLoop.execution[0]?.detail).toContain('source=worker-decision-comment-recovery');
  });

  it('immediately starts the next ticket after a terminal completion during the normal workflow loop', async () => {
    const adapter = {
      name: vi.fn(() => 'plane'),
      whoami: vi.fn(async () => ({ id: 'me' })),
      listIdsByStage: vi.fn(async () => []),
      addComment: vi.fn(async () => undefined),
      setStage: vi.fn(async () => undefined),
      listBacklogIdsInOrder: vi.fn(async () => []),
      getWorkItem: vi.fn(async (id: string) => makeWorkItem(id, `Ticket ${id}`)),
      listComments: vi.fn(async () => []),
      listAttachments: vi.fn(async () => []),
      listLinkedWorkItems: vi.fn(async () => []),
      updateComment: vi.fn(async () => undefined),
      deleteComment: vi.fn(async () => undefined),
    };

    const previousMap = {
      version: 1 as const,
      active: { ticketId: 'A1', sessionId: 'jules-1' },
      sessionsByTicket: {
        A1: {
          sessionId: 'jules-1',
          lastState: 'in_progress' as const,
          lastSeenAt: '2026-03-15T18:00:00.000Z',
          workStartedAt: '2026-03-15T18:00:00.000Z',
        },
      },
    };
    const output = {
      tick: { kind: 'in_progress' as const, id: 'A1', inProgressIds: ['A1'] },
      nextTicket: {
        item: { id: 'A1', title: 'Completed ticket' },
        comments: [
          {
            id: 'c-1',
            body: 'Worker decision: completed\n\nSolution summary:\n- Fixed it',
            createdAt: new Date('2026-03-15T18:10:00.000Z'),
          },
        ],
      },
      dryRun: false,
    };
    runWorkflowLoopSelection.mockResolvedValue({
      tick: { kind: 'started', id: 'B1', reasonCode: 'start_next_assigned_backlog' },
      nextTicket: {
        item: { id: 'B1', title: 'Next ticket' },
        comments: [],
      },
      dryRun: false,
    });
    (dispatchWorkerTurn as any).mockResolvedValueOnce({
      kind: 'delegated',
      runId: 'run-2',
      startedAt: '2026-03-15T18:11:00.000Z',
      waitTimeoutSeconds: 3600,
      sessionKey: 'agent:kanban-workflow-worker:b1',
      notice: 'delegated',
    });

    const result = await runWorkflowLoopController({
      adapter,
      output,
      previousMap,
      dryRun: false,
      dispatchRunId: 'dispatch-3',
      workerAgentId: 'kanban-workflow-worker',
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        isBackgroundDelegationAllowed: () => false,
      },
      requeueTargetStage: 'stage:todo',
    });

    expect(runWorkflowLoopSelection).toHaveBeenCalledTimes(1);
    expect(dispatchWorkerTurn).toHaveBeenCalledTimes(1);
    expect((dispatchWorkerTurn.mock.calls as unknown as Array<[any]>)[0]?.[0]).toMatchObject({ ticketId: 'B1' });
    expect(result.quiet).toBe(false);
    if (result.quiet) return;
    expect(result.payload.workflowLoop.execution).toHaveLength(2);
    expect(result.payload.workflowLoop.execution[0]?.outcome).toBe('applied');
    expect(result.payload.workflowLoop.execution[1]?.outcome).toBe('delegated_started');
    expect(result.payload.workflowLoop.activeTicketId).toBe('B1');
  });
});
