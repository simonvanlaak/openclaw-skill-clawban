import { randomUUID } from 'node:crypto';

import { execa } from 'execa';

import { parseWorkerOutputFromAgentCall } from './agent_io.js';
import { parseDecisionChoice, type DecisionChoice, type WorkerReportFacts } from './decision_policy.js';

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? '');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function decideWithAgent(params: {
  map: { [key: string]: unknown };
  ticketId: string;
  report: string;
  facts: WorkerReportFacts;
}): Promise<DecisionChoice | null> {
  const mapAny = params.map as any;
  const decisionAgentId = (process.env.KWF_DECISION_AGENT_ID ?? 'kanban-workflow-decision').trim() || 'kanban-workflow-decision';
  const maxTicketsPerSession = 5;
  const maxContextTokens = resolvePositiveInt(process.env.KWF_DECISION_CONTEXT_TOKENS, 272_000);
  const charsPerToken = 4;
  const maxChars = maxContextTokens * charsPerToken;
  const rotateAt = 0.5;

  const state = (mapAny.decisionSession ??= {
    sessionId: randomUUID(),
    ticketsUsedCount: 0,
    contextChars: 0,
  });

  const usageRatio = (state.contextChars ?? 0) / maxChars;
  if ((state.ticketsUsedCount ?? 0) >= maxTicketsPerSession || usageRatio >= rotateAt) {
    state.sessionId = randomUUID();
    state.ticketsUsedCount = 0;
    state.contextChars = 0;
  }

  const prompt = [
    'Decide exactly one workflow outcome for this ticket.',
    'Allowed labels: continue, blocked, completed.',
    'Respond with one word only.',
    `Ticket: ${params.ticketId}`,
    `Missing required report fields: ${params.facts.missing.length > 0 ? params.facts.missing.join(', ') : 'none'}`,
    '',
    'WORKER_REPORT',
    params.report,
  ].join('\n');

  try {
    const run = await execa('openclaw', [
      'agent',
      '--agent',
      decisionAgentId,
      '--session-id',
      state.sessionId,
      '--thinking',
      'low',
      '--timeout',
      '30',
      '--message',
      prompt,
      '--json',
    ]);

    const parsed = parseWorkerOutputFromAgentCall(run.stdout, run.stderr);
    if (!parsed.ok) return null;

    state.ticketsUsedCount = Number(state.ticketsUsedCount ?? 0) + 1;
    state.contextChars = Number(state.contextChars ?? 0) + prompt.length + parsed.workerOutput.length;

    return parseDecisionChoice(parsed.workerOutput);
  } catch {
    return null;
  }
}
