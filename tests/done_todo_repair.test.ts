import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { runDoneTodoRepair } from '../src/workflow/done_todo_repair.js';

type ExecaMock = typeof execa & {
  mockReset: () => void;
  mockResolvedValueOnce: (value: unknown) => ExecaMock;
};

describe('done_todo_repair', () => {
  beforeEach(() => {
    (execa as any as ExecaMock).mockReset();
    process.env.PLANE_API_KEY = 'test-key';
    process.env.PLANE_BASE_URL = 'https://plane.example';
    vi.unstubAllGlobals();
  });

  it('moves current todo tickets back to done when they were reopened from done by the worker actor', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/states/')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              { id: 'todo-state', name: 'Todo' },
              { id: 'done-state', name: 'Done' },
            ],
          }),
        };
      }
      if (url.endsWith('/work-items/')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                id: 'T1',
                sequence_id: 301,
                name: 'Accidentally reopened',
                state: { id: 'todo-state', name: 'Todo' },
              },
              {
                id: 'T2',
                sequence_id: 302,
                name: 'Legit todo',
                state: { id: 'todo-state', name: 'Todo' },
              },
            ],
          }),
        };
      }
      if (url.includes('/work-items/T1/activities/')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                field: 'state',
                old_value: { id: 'done-state', name: 'Done' },
                new_value: { id: 'todo-state', name: 'Todo' },
                actor: 'me-1',
                created_at: '2026-03-15T19:10:00Z',
              },
            ],
          }),
        };
      }
      if (url.includes('/work-items/T2/activities/')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                field: 'state',
                old_value: { id: 'blocked-state', name: 'Blocked' },
                new_value: { id: 'todo-state', name: 'Todo' },
                actor: 'me-1',
                created_at: '2026-03-15T19:11:00Z',
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    (execa as any as ExecaMock).mockResolvedValueOnce({ stdout: '{}' });

    const result = await runDoneTodoRepair({
      workspaceSlug: 'ws',
      projectIds: ['proj-1'],
      actorId: 'me-1',
      dryRun: false,
      sinceHours: 24,
    });

    expect(result.repaired).toEqual([
      {
        ticketId: 'T1',
        projectId: 'proj-1',
        sequenceId: 301,
        title: 'Accidentally reopened',
        todoActivityAt: '2026-03-15T19:10:00Z',
      },
    ]);
    expect(execa).toHaveBeenCalledWith(
      'plane',
      ['-f', 'json', 'issues', 'update', '-p', 'proj-1', '--state', 'done-state', 'T1'],
      expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' }),
    );
  });

  it('supports dry-run without mutating Plane', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => {
        if (url.endsWith('/states/')) return { results: [{ id: 'done-state', name: 'Done' }] };
        if (url.endsWith('/work-items/')) {
          return { results: [{ id: 'T1', sequence_id: 301, name: 'Accidentally reopened', state: { name: 'Todo' } }] };
        }
        return {
          results: [
            { field: 'state', old_value: { name: 'Done' }, new_value: { name: 'Todo' }, actor: 'me-1' },
          ],
        };
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runDoneTodoRepair({
      workspaceSlug: 'ws',
      projectIds: ['proj-1'],
      actorId: 'me-1',
      dryRun: true,
      sinceHours: 24,
    });

    expect(result.repaired).toHaveLength(1);
    expect(execa).not.toHaveBeenCalled();
  });

  it('ignores older historical done-to-todo transitions outside the repair window', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => {
        if (url.endsWith('/states/')) return { results: [{ id: 'done-state', name: 'Done' }] };
        if (url.endsWith('/work-items/')) {
          return { results: [{ id: 'T1', sequence_id: 301, name: 'Historical reopen', state: { name: 'Todo' } }] };
        }
        return {
          results: [
            {
              field: 'state',
              old_value: { name: 'Done' },
              new_value: { name: 'Todo' },
              actor: 'me-1',
              created_at: '2026-03-10T19:10:00Z',
            },
          ],
        };
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runDoneTodoRepair({
      workspaceSlug: 'ws',
      projectIds: ['proj-1'],
      actorId: 'me-1',
      dryRun: true,
      sinceHours: 24,
    });

    expect(result.repaired).toEqual([]);
  });
});
