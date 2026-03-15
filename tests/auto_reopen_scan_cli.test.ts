import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runAutoReopenOnHumanComment } = vi.hoisted(() => ({
  runAutoReopenOnHumanComment: vi.fn(async () => ({
    actions: [
      { ticketId: 'A1', fromStage: 'stage:blocked', toStage: 'stage:todo', triggerCommentId: 'c-human-1' },
    ],
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

vi.mock('../src/automation/session_dispatcher.js', async () => {
  const actual = await vi.importActual<typeof import('../src/automation/session_dispatcher.js')>('../src/automation/session_dispatcher.js');
  return {
    ...actual,
    loadSessionMap: vi.fn(async () => ({ version: 1, sessionsByTicket: {} })),
    saveSessionMap: vi.fn(async () => undefined),
  };
});

vi.mock('../src/automation/auto_reopen.js', async () => {
  const actual = await vi.importActual<typeof import('../src/automation/auto_reopen.js')>('../src/automation/auto_reopen.js');
  return {
    ...actual,
    runAutoReopenOnHumanComment,
  };
});

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

describe('auto-reopen-scan cli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the command to the fallback auto-reopen scan and prints the result payload', async () => {
    const { io, cap } = createIo();

    const code = await runCli(['auto-reopen-scan', '--dry-run'], io);

    expect(code).toBe(0);
    const args = ((runAutoReopenOnHumanComment.mock.calls as unknown as Array<[any]>)[0]?.[0]);
    expect(args).toMatchObject({
      dryRun: true,
      requeueTargetStage: 'stage:todo',
    });
    expect(cap.out.join('')).toContain('"autoReopenScan"');
  });
});
