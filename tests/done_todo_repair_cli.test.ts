import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runDoneTodoRepair } = vi.hoisted(() => ({
  runDoneTodoRepair: vi.fn(async () => ({
    repaired: [{ ticketId: 'T1', projectId: 'p1', sequenceId: 301, title: 'Accidentally reopened' }],
    scannedTodoTickets: 4,
    dryRun: true,
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
    whoami: vi.fn(async () => ({ id: 'me-1' })),
  })),
}));

vi.mock('../src/workflow/done_todo_repair.js', () => ({
  runDoneTodoRepair,
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

describe('repair-done-todo cli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the command to the done/todo repairer', async () => {
    const { io, cap } = createIo();

    const code = await runCli(['repair-done-todo', '--dry-run'], io);

    expect(code).toBe(0);
    const args = ((runDoneTodoRepair.mock.calls as unknown as Array<[any]>)[0]?.[0]);
    expect(args).toMatchObject({
      workspaceSlug: 'ws',
      projectIds: ['p1'],
      actorId: 'me-1',
      dryRun: true,
    });
    expect(cap.out.join('')).toContain('"doneTodoRepair"');
  });
});
