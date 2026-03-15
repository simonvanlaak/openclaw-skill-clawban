import { describe, expect, it } from 'vitest';

import { buildTicketProbe, extractDuplicateKeywords, scoreDuplicateCandidate } from '../src/workflow/ticket_probe.js';

describe('ticket_probe', () => {
  it('extracts stable duplicate keywords from title and body', () => {
    expect(
      extractDuplicateKeywords({
        title: 'Fix Plane webhook latency for ticket status movement',
        body: 'Webhook should move Plane status almost instantly after a human comment.',
      }),
    ).toEqual(expect.arrayContaining(['webhook', 'latency', 'status', 'movement', 'human']));
  });

  it('scores duplicate candidates by shared keywords', () => {
    const scored = scoreDuplicateCandidate({
      currentId: 'A1',
      keywords: ['webhook', 'latency', 'status'],
      candidate: {
        id: 'A2',
        identifier: 'JULES-237',
        title: 'Fix webhook latency for status updates',
        body: 'Plane status movement is delayed.',
      },
    });

    expect(scored.sharedKeywords).toEqual(['webhook', 'latency', 'status']);
    expect(scored.score).toBeGreaterThan(3);
  });

  it('builds a compact ticket probe from adapter data', async () => {
    const adapter = {
      name: () => 'plane',
      async listIdsByStage(stage: string) {
        if (stage === 'stage:todo') return ['A1', 'A2'];
        return [];
      },
      async getWorkItem(id: string) {
        if (id === 'A1') {
          return {
            id: 'A1',
            projectId: 'P1',
            identifier: 'JULES-237',
            title: 'Fix webhook latency for status updates',
            body: 'Plane status should move quickly after a human comment.',
            stage: 'stage:todo' as const,
            url: 'https://plane/A1',
            labels: ['workflow'],
            assignees: ['me'],
            updatedAt: new Date('2026-03-15T20:00:00.000Z'),
          };
        }

        return {
          id: 'A2',
          projectId: 'P1',
          identifier: 'JULES-999',
          title: 'Investigate webhook status delay',
          body: 'Latency affects ticket state changes.',
          stage: 'stage:todo' as const,
          url: 'https://plane/A2',
          labels: [],
          assignees: [],
          updatedAt: new Date('2026-03-15T19:00:00.000Z'),
        };
      },
      async listComments() {
        return [
          {
            id: 'C1',
            body: 'Worker decision: completed\nSolution summary: fixed it',
            createdAt: new Date('2026-03-15T19:00:00.000Z'),
            author: { name: 'Jules Mercer' },
          },
          {
            id: 'C2',
            body: 'This is still too slow after my test comment.',
            createdAt: new Date('2026-03-15T20:10:00.000Z'),
            author: { name: 'Simon van Laak' },
          },
        ];
      },
      async listAttachments() {
        return [{ filename: 'trace.log', url: 'https://files/trace.log' }];
      },
      async listLinkedWorkItems() {
        return [{ id: 'L1', title: 'Related issue', relation: 'blocks', url: 'https://plane/L1' }];
      },
    };

    const probe = await buildTicketProbe({ adapter, ticketId: 'A1' });
    expect(probe.ticket.identifier).toBe('JULES-237');
    expect(probe.ticket.attachmentCount).toBe(1);
    expect(probe.recentHumanComments).toHaveLength(1);
    expect(probe.recentWorkerComments).toHaveLength(1);
    expect(probe.likelyDuplicates[0]).toMatchObject({
      id: 'A2',
      identifier: 'JULES-999',
    });
  });
});
