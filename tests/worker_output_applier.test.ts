import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMap } from '../src/automation/session_dispatcher.js';

const { dispatchWorkerTurn } = vi.hoisted(() => ({
  dispatchWorkerTurn: vi.fn(async () => {
    throw new Error('dispatch should not be called in these tests');
  }),
}));

vi.mock('../src/workflow/worker_runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../src/workflow/worker_runtime.js')>('../src/workflow/worker_runtime.js');
  return {
    ...actual,
    dispatchWorkerTurn,
  };
});

import { applyWorkerOutputToTicket } from '../src/workflow/worker_output_applier.js';

function completedWorkerOutput() {
  return JSON.stringify({
    decision: 'completed',
    completed_steps: ['Implemented the fix and verified the workflow behavior.'],
    clarification_questions: [],
    blocker_resolve_requests: [],
    solution_summary: 'The fix is complete and ready for review.',
    evidence: ['npm test passed for the relevant workflow suites.'],
  });
}

describe('worker_output_applier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists pending mutation progress when comment succeeds but stage update fails', async () => {
    const map: SessionMap = {
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
      addComment: vi.fn(async () => undefined),
      setStage: vi.fn(async () => {
        throw new Error('plane stage update failed');
      }),
      listComments: vi.fn(async () => []),
    };
    const persistMap = vi.fn(async () => undefined);

    await expect(
      applyWorkerOutputToTicket({
        adapter,
        map,
        action: { ticketId: 'A1', sessionId: 'jules-237', projectId: 'P1' },
        workerOutput: completedWorkerOutput(),
        dispatchRunId: 'dispatch-1',
        workerAgentId: 'main',
        workerRuntimeOptions: {
          delegationDir: '.tmp/test-delegations',
          defaultSyncTimeoutMs: 30_000,
          defaultBackgroundTimeoutMs: 60_000,
          isBackgroundDelegationAllowed: () => false,
        },
        persistMap,
      }),
    ).rejects.toThrow('plane stage update failed');

    expect(adapter.addComment).toHaveBeenCalledOnce();
    expect(adapter.setStage).toHaveBeenCalledWith('A1', 'stage:in-review');
    expect(persistMap).toHaveBeenCalledTimes(2);
    expect(map.sessionsByTicket.A1.pendingMutation?.kind).toBe('worker_result');
    if (map.sessionsByTicket.A1.pendingMutation?.kind !== 'worker_result') {
      throw new Error('expected worker_result pending mutation');
    }
    expect(map.sessionsByTicket.A1.pendingMutation.commentAppliedAt).toBeTruthy();
    expect(map.sessionsByTicket.A1.pendingMutation.stageAppliedAt).toBeUndefined();
    expect(map.sessionsByTicket.A1.lastState).toBe('in_progress');
    expect(map.active).toEqual({ ticketId: 'A1', sessionId: 'jules-237' });
  });

  it('replays a pending mutation without duplicating the completion comment', async () => {
    const map: SessionMap = {
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
    const firstAdapter = {
      addComment: vi.fn(async () => undefined),
      setStage: vi.fn(async () => {
        throw new Error('plane stage update failed');
      }),
      listComments: vi.fn(async () => []),
    };
    const persistMap = vi.fn(async () => undefined);

    await expect(
      applyWorkerOutputToTicket({
        adapter: firstAdapter,
        map,
        action: { ticketId: 'A1', sessionId: 'jules-237', projectId: 'P1' },
        workerOutput: completedWorkerOutput(),
        dispatchRunId: 'dispatch-1',
        workerAgentId: 'main',
        workerRuntimeOptions: {
          delegationDir: '.tmp/test-delegations',
          defaultSyncTimeoutMs: 30_000,
          defaultBackgroundTimeoutMs: 60_000,
          isBackgroundDelegationAllowed: () => false,
        },
        persistMap,
      }),
    ).rejects.toThrow('plane stage update failed');

    const pending = map.sessionsByTicket.A1.pendingMutation;
    expect(pending?.kind).toBe('worker_result');
    const commentBody = pending?.kind === 'worker_result' ? pending.commentBody : undefined;
    expect(commentBody).toBeTruthy();

    const replayAdapter = {
      addComment: vi.fn(async () => undefined),
      setStage: vi.fn(async () => undefined),
      hasCommentOperation: vi.fn(async () => true),
      listComments: vi.fn(async () => [
        {
          id: 'c-1',
          body: String(commentBody),
          createdAt: new Date('2026-03-15T16:18:04.000Z'),
        },
      ]),
    };

    const result = await applyWorkerOutputToTicket({
      adapter: replayAdapter,
      map,
      action: { ticketId: 'A1', sessionId: 'jules-237', projectId: 'P1' },
      workerOutput: completedWorkerOutput(),
      dispatchRunId: 'dispatch-2',
      workerAgentId: 'main',
      workerRuntimeOptions: {
        delegationDir: '.tmp/test-delegations',
        defaultSyncTimeoutMs: 30_000,
        defaultBackgroundTimeoutMs: 60_000,
        isBackgroundDelegationAllowed: () => false,
      },
      persistMap,
    });

    expect(result.outcome).toBe('applied');
    expect(replayAdapter.addComment).not.toHaveBeenCalled();
    expect(replayAdapter.setStage).toHaveBeenCalledWith('A1', 'stage:in-review');
    expect(map.active).toBeUndefined();
    expect(map.sessionsByTicket.A1.lastState).toBe('completed');
    expect(map.sessionsByTicket.A1.pendingMutation).toBeUndefined();
  });
});
