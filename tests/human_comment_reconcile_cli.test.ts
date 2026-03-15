import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runHumanCommentReconciler } = vi.hoisted(() => ({
  runHumanCommentReconciler: vi.fn(async () => ({
    quiet: false,
    exitCode: 0,
    payload: {
      humanCommentReconcile: {
        ticketId: 'A1',
        commentId: 'c-human-1',
        fromStage: 'stage:blocked',
        actions: [
          { ticketId: 'A1', fromStage: 'stage:blocked', toStage: 'stage:todo', triggerCommentId: 'c-human-1' },
        ],
        mapPath: '.tmp/kwf-session-map.json',
      },
    },
  })),
}));

vi.mock('../src/setup.js', () => ({
  runSetup: vi.fn(async () => undefined),
}));

vi.mock('../src/config.js', () => ({
  loadConfigFromFile: vi.fn(async () => ({
    version: 1,
    autopilot: { requeueTargetStage: 'stage:todo' },
    adapter: { kind: 'plane', workspaceSlug: 'ws', projectIds: ['p1'], stageMap: {} },
  })),
}));

vi.mock('../src/adapters/plane.js', () => ({
  PlaneAdapter: vi.fn().mockImplementation(() => ({
    name: () => 'plane',
  })),
}));

vi.mock('../src/workflow/human_comment_reconciler.js', () => ({
  runHumanCommentReconciler,
}));

import { runCli } from '../src/cli.js';

function createIo(): { io: any; cap: { out: string[]; err: string[] } } {
  const cap = { out: [] as string[], err: [] as string[] };
  return {
    cap,
    io: {
      stdout: { write: (chunk: string) => cap.out.push(chunk) },
      stderr: { write: (chunk: string) => cap.err.push(chunk) },
    },
  };
}

describe('reconcile-human-comment cli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the command to the human comment reconciler with the requested ids', async () => {
    const { io, cap } = createIo();

    const code = await runCli(['reconcile-human-comment', '--ticket-id', 'A1', '--comment-id', 'c-human-1'], io);

    expect(code).toBe(0);
    const args = ((runHumanCommentReconciler.mock.calls as unknown as Array<[any]>)[0]?.[0]);
    expect(args).toMatchObject({
      ticketId: 'A1',
      commentId: 'c-human-1',
      requeueTargetStage: 'stage:todo',
    });
    expect(cap.out.join('')).toContain('"humanCommentReconcile"');
  });
});
