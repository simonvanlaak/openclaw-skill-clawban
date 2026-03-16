import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFile } = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

const { appendFile, mkdir } = vi.hoisted(() => ({
  appendFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
}));

vi.mock('node:child_process', () => ({
  execFile,
}));

vi.mock('node:fs/promises', () => ({
  appendFile,
  mkdir,
}));

// @ts-ignore test imports a JS hook file directly
import kwfSubagentEnded from '../hooks/kwf-subagent-ended/handler.js';

describe('kwf-subagent-ended hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => cb(null, '', ''));
  });

  it('runs reconcile-subagent-ended and reconcile-active-runs for main worker subagents', async () => {
    await kwfSubagentEnded({
      targetSessionKey: 'agent:main:subagent:child-265',
      runId: 'run-265',
      reason: 'subagent-complete',
    });

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[0]?.[1]).toEqual([
      'run',
      '-s',
      'kanban-workflow',
      '--',
      'reconcile-subagent-ended',
      '--child-session-key',
      'agent:main:subagent:child-265',
    ]);
    expect(execFile.mock.calls[1]?.[1]).toEqual([
      'run',
      '-s',
      'kanban-workflow',
      '--',
      'reconcile-active-runs',
    ]);
  });

  it('ignores non-worker session keys', async () => {
    await kwfSubagentEnded({
      targetSessionKey: 'agent:other:subagent:child-265',
    });

    expect(execFile).not.toHaveBeenCalled();
  });
});
