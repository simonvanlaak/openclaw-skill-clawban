import {
  applyWorkerCommandToSessionMap,
  type SessionMap,
  type WorkerCommandResult,
} from '../automation/session_dispatcher.js';
import type { WorkflowLifecycleAdapter, WorkflowLoopSelectionOutput } from './workflow_loop_ports.js';
import type { WorkerExecutionOutcome } from './worker_output_applier.js';

type RecoverableDecision = {
  parsed: WorkerCommandResult;
  stage: 'stage:in-review' | 'stage:blocked';
  createdAt?: Date;
};

function parseRecoverableDecision(body: string): RecoverableDecision | null {
  const text = String(body ?? '').trim();
  if (!text) return null;

  const match = text.match(/^Worker decision:\s*(completed|blocked|uncertain)\b/i);
  const decision = match?.[1]?.toLowerCase();
  if (decision === 'completed') {
    return {
      parsed: { kind: 'completed', result: text },
      stage: 'stage:in-review',
    };
  }
  if (decision === 'blocked' || decision === 'uncertain') {
    return {
      parsed: { kind: 'blocked', text },
      stage: 'stage:blocked',
    };
  }
  return null;
}

function isDecisionNewerThanCurrentAttempt(params: {
  createdAt?: Date;
  workStartedAt?: string;
}): boolean {
  if (!params.createdAt) return true;
  if (!params.workStartedAt) return true;

  const startedMs = Date.parse(params.workStartedAt);
  const createdMs = params.createdAt.getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(createdMs)) return true;
  return createdMs >= startedMs;
}

export async function recoverWorkerDecisionFromComments(params: {
  adapter: Pick<WorkflowLifecycleAdapter, 'setStage'>;
  map: SessionMap;
  output: WorkflowLoopSelectionOutput;
  action: { ticketId: string; sessionId: string };
  onCompleted?(ticketId: string, completedAt: Date): void;
}): Promise<WorkerExecutionOutcome | null> {
  if (params.output.tick.kind !== 'in_progress') return null;
  if (params.output.nextTicket?.item?.id !== params.action.ticketId) return null;

  const comments = Array.isArray(params.output.nextTicket?.comments) ? params.output.nextTicket.comments : [];
  if (comments.length === 0) return null;

  const workStartedAt = params.map.sessionsByTicket?.[params.action.ticketId]?.workStartedAt;
  const recoverable = comments
    .map((comment) => {
      const parsed = parseRecoverableDecision(comment.body);
      if (!parsed) return null;
      return {
        ...parsed,
        createdAt: comment.createdAt,
      };
    })
    .find((entry) => entry && isDecisionNewerThanCurrentAttempt({ createdAt: entry.createdAt, workStartedAt }));

  if (!recoverable) return null;

  await params.adapter.setStage(params.action.ticketId, recoverable.stage);

  const appliedAt = new Date();
  if (recoverable.parsed.kind === 'completed') {
    params.onCompleted?.(params.action.ticketId, appliedAt);
  }
  applyWorkerCommandToSessionMap(params.map, params.action.ticketId, recoverable.parsed, appliedAt);

  return {
    sessionId: params.action.sessionId,
    ticketId: params.action.ticketId,
    parsed: recoverable.parsed,
    workerOutput: recoverable.parsed.kind === 'completed' ? recoverable.parsed.result : recoverable.parsed.text,
    outcome: 'applied',
    detail: `source=worker-decision-comment-recovery; decision=${recoverable.parsed.kind}`,
  };
}
