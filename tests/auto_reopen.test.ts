import * as fs from 'node:fs/promises';

import { describe, expect, test, vi } from 'vitest';

import { runAutoReopenForTicket, runAutoReopenOnHumanComment } from '../src/automation/auto_reopen.js';

function cursorPath(name: string): string {
  return `.tmp/${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

describe('auto-reopen on human comment', () => {
  test('moves blocked ticket back to backlog when a non-worker comment appears', async () => {
    const path = cursorPath('kwf-auto-reopen-blocked');
    const map = {
      version: 1 as const,
      sessionsByTicket: {
        'BL-1': {
          sessionId: 'bl-1',
          lastState: 'blocked' as const,
          lastSeenAt: '2026-02-28T13:00:00Z',
          workStartedAt: '2026-02-28T12:00:00Z',
          continueCount: 1,
        },
      },
    };
    const adapter = {
      whoami: vi.fn(async () => ({ username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async (stage: string) => (stage === 'stage:blocked' ? ['BL-1'] : [])),
      listComments: vi.fn(async () => [
        {
          id: 'c-human-1',
          body: 'Can take this now.',
          author: { username: 'alice' },
          createdAt: new Date('2026-02-28T14:00:00Z'),
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, map, cursorPath: path });

    expect(res.actions).toEqual([
      { ticketId: 'BL-1', fromStage: 'stage:blocked', toStage: 'stage:todo', triggerCommentId: 'c-human-1' },
    ]);
    expect(adapter.setStage).toHaveBeenCalledWith('BL-1', 'stage:todo');
    expect(map.sessionsByTicket['BL-1']?.lastState).toBe('queued');
    expect(map.sessionsByTicket['BL-1']?.workStartedAt).toBeUndefined();
    expect(map.sessionsByTicket['BL-1']?.continueCount).toBeUndefined();

    await fs.rm(path, { force: true });
  });

  test('moves in-review ticket back to backlog when a non-worker comment appears', async () => {
    const path = cursorPath('kwf-auto-reopen-in-review');
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'kwf-user-1', username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async (stage: string) => (stage === 'stage:in-review' ? ['RV-2'] : [])),
      listComments: vi.fn(async () => [
        {
          id: 'c-human-2',
          body: 'Please take another pass.',
          author: { id: 'human-2', username: 'pm-jane' },
          createdAt: new Date('2026-02-28T14:01:00Z'),
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, cursorPath: path });

    expect(res.actions).toEqual([
      { ticketId: 'RV-2', fromStage: 'stage:in-review', toStage: 'stage:todo', triggerCommentId: 'c-human-2' },
    ]);
    expect(adapter.setStage).toHaveBeenCalledWith('RV-2', 'stage:todo');

    await fs.rm(path, { force: true });
  });

  test('does not reopen when newest unseen comment is from worker account', async () => {
    const path = cursorPath('kwf-auto-reopen-self');
    const adapter = {
      whoami: vi.fn(async () => ({ username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async (stage: string) => (stage === 'stage:blocked' ? ['BL-3'] : [])),
      listComments: vi.fn(async () => [
        {
          id: 'c-self-1',
          body: 'Internal update',
          author: { username: 'kwf-bot' },
          createdAt: new Date('2026-02-28T14:03:00Z'),
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, cursorPath: path });

    expect(res.actions).toEqual([]);
    expect(adapter.setStage).not.toHaveBeenCalled();

    await fs.rm(path, { force: true });
  });

  test('reopens when worker relays a human comment in body metadata', async () => {
    const path = cursorPath('kwf-auto-reopen-relayed-human');
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'bot-1', username: 'kwf-bot', name: 'Jules Mercer' })),
      listIdsByStage: vi.fn(async (stage: string) => (stage === 'stage:in-review' ? ['RV-9'] : [])),
      listComments: vi.fn(async () => [
        {
          id: 'c-relay-1',
          body: '[planka-comment:123]\nAuthor: Simon van Laak\nCreated: 2026-02-28T14:01:00Z\n\nPlease revise this.',
          author: { id: 'bot-1', username: 'kwf-bot', name: 'Jules Mercer' },
          createdAt: new Date('2026-02-28T14:03:00Z'),
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, cursorPath: path });

    expect(res.actions).toEqual([
      { ticketId: 'RV-9', fromStage: 'stage:in-review', toStage: 'stage:todo', triggerCommentId: 'c-relay-1' },
    ]);
    expect(adapter.setStage).toHaveBeenCalledWith('RV-9', 'stage:todo');

    await fs.rm(path, { force: true });
  });

  test('does not reopen on stale human comment once a newer worker decision exists', async () => {
    const path = cursorPath('kwf-auto-reopen-stale-human-after-worker-decision');
    await fs.writeFile(path, JSON.stringify({ version: 1, seenByTicket: { 'BL-7': 'seen-old' } }), 'utf8');

    const adapter = {
      whoami: vi.fn(async () => ({ id: 'bot-1', username: 'kwf-bot', name: 'Jules Mercer' })),
      listIdsByStage: vi.fn(async (stage: string) => (stage === 'stage:blocked' ? ['BL-7'] : [])),
      listComments: vi.fn(async () => [
        {
          id: 'c-worker-decision-new',
          body: 'Worker decision: blocked\n\nCompleted steps:\n1. Checked logs',
          author: { id: 'bot-1', username: 'kwf-bot', name: 'Jules Mercer' },
        },
        {
          id: 'c-human-older',
          body: 'Any update?',
          author: { id: 'human-1', username: 'alice' },
        },
        {
          id: 'seen-old',
          body: 'older cursor marker',
          author: { id: 'bot-1', username: 'kwf-bot' },
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, cursorPath: path });

    expect(res.actions).toEqual([]);
    expect(adapter.setStage).not.toHaveBeenCalled();

    await fs.rm(path, { force: true });
  });

  test('moves done ticket back to backlog when a non-worker comment appears', async () => {
    const path = cursorPath('kwf-auto-reopen-done');
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'kwf-user-1', username: 'kwf-bot' })),
      listIdsByStage: vi.fn(async () => []),
      listIdsInDoneState: vi.fn(async () => ['DN-4']),
      listComments: vi.fn(async () => [
        {
          id: 'c-human-4',
          body: 'This still needs one more change.',
          author: { id: 'human-4', username: 'pm-jane' },
          createdAt: new Date('2026-03-15T16:00:00Z'),
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenOnHumanComment({ adapter, cursorPath: path });

    expect(res.actions).toEqual([
      { ticketId: 'DN-4', fromStage: 'state:done', toStage: 'stage:todo', triggerCommentId: 'c-human-4' },
    ]);
    expect(adapter.setStage).toHaveBeenCalledWith('DN-4', 'stage:todo');

    await fs.rm(path, { force: true });
  });

  test('reopens a single ticket only when the explicit trigger comment is still current relative to worker decisions', async () => {
    const path = cursorPath('kwf-auto-reopen-single-ticket-trigger');
    const map = {
      version: 1 as const,
      sessionsByTicket: {
        'BL-8': {
          sessionId: 'bl-8',
          lastState: 'blocked' as const,
          lastSeenAt: '2026-03-15T15:00:00Z',
          workStartedAt: '2026-03-15T14:00:00Z',
        },
      },
    };
    const adapter = {
      whoami: vi.fn(async () => ({ id: 'bot-1', username: 'kwf-bot', name: 'Jules Mercer' })),
      listIdsByStage: vi.fn(async () => []),
      listComments: vi.fn(async () => [
        {
          id: 'c-human-latest',
          body: 'Please retry with the new requirement.',
          author: { id: 'human-1', username: 'alice' },
        },
        {
          id: 'c-worker-older',
          body: 'Worker decision: blocked\n\nBlocker resolve requests:\n1. Need clarification',
          author: { id: 'bot-1', username: 'kwf-bot', name: 'Jules Mercer' },
        },
      ]),
      setStage: vi.fn(async () => undefined),
    };

    const res = await runAutoReopenForTicket({
      adapter,
      ticketId: 'BL-8',
      fromStage: 'stage:blocked',
      map,
      cursorPath: path,
      expectedTriggerCommentId: 'c-human-latest',
    });

    expect(res.actions).toEqual([
      { ticketId: 'BL-8', fromStage: 'stage:blocked', toStage: 'stage:todo', triggerCommentId: 'c-human-latest' },
    ]);
    expect(adapter.setStage).toHaveBeenCalledWith('BL-8', 'stage:todo');
    expect(map.sessionsByTicket['BL-8']?.lastState).toBe('queued');

    await fs.rm(path, { force: true });
  });
});
