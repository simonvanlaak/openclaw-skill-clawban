import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/setup.js', () => ({
  runSetup: vi.fn(async () => undefined),
}));

vi.mock('../src/config.js', () => ({
  loadConfigFromFile: vi.fn(async () => ({
    version: 1,
    adapter: { kind: 'plane', workspaceSlug: 'ws', projectIds: ['p1'], stageMap: {} },
  })),
}));

vi.mock('../src/adapters/plane.js', () => ({
  PlaneAdapter: vi.fn().mockImplementation(() => ({
    cli: {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === 'projects' && args[1] === 'list') return JSON.stringify([{ id: 'p1' }]);
        if (args[0] === 'states' && args[1] === 'list') return JSON.stringify([{ name: 'Backlog' }, { name: 'Blocked' }, { name: 'In Progress' }, { name: 'In Review' }]);
        return '[]';
      }),
    },
  })),
}));

vi.mock('../src/verbs/verbs.js', () => ({
  show: vi.fn(async () => ({ id: 'X' })),
  next: vi.fn(async () => ({ id: 'X' })),
  start: vi.fn(async () => undefined),
  update: vi.fn(async () => undefined),
  ask: vi.fn(async () => undefined),
  complete: vi.fn(async () => undefined),
  create: vi.fn(async () => ({ id: 'X' })),
}));

import { runCli } from '../src/cli.js';
import { loadConfigFromFile } from '../src/config.js';
import { runSetup } from '../src/setup.js';

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

describe('cli what-next tips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prints a workflow-loop tip after setup', async () => {
    const { io, cap } = createIo();

    const code = await runCli(
      [
        'setup',
        '--adapter',
        'plane',
        '--force',
        '--map-backlog',
        'Backlog',
        '--map-blocked',
        'Blocked',
        '--map-in-progress',
        'In Progress',
        '--map-in-review',
        'In Review',
        '--plane-workspace-slug',
        'ws',
        '--plane-scope',
        'all-projects',
      ],
      io,
    );

    expect(code).toBe(0);
    expect(runSetup).toHaveBeenCalledOnce();
    expect(cap.out.join('')).toMatch(/Wrote config\/kanban-workflow\.json/);
    expect(cap.out.join('')).toMatch(/What next: run `kanban-workflow workflow-loop`/);
  });

  it.each([
    ['show', ['show', '--id', '1']],
    ['create', ['create', '--project-id', 'p1', '--title', 't', '--body', 'b']],
    ['workflow-loop', ['workflow-loop']],
  ])('errors with setup instructions when config is missing/invalid (%s)', async (_name, argv) => {
    const { io, cap } = createIo();

    vi.mocked(loadConfigFromFile).mockRejectedValueOnce(new Error('ENOENT'));

    const code = await runCli(argv, io);

    expect(code).toBe(1);
    expect(cap.err.join('')).toMatch(/Setup not completed/i);
    expect(cap.err.join('')).toMatch(/What next: run `kanban-workflow setup`/);
  });
});
