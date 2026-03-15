import {
  applyWorkerCommandToSessionMap,
  buildWorkflowLoopPlan,
  markSessionInProgress,
  saveSessionMap,
  type SessionMap,
  type WorkerCommandResult,
} from '../automation/session_dispatcher.js';
import { shouldQuietPollAfterCarryForward } from './decision_policy.js';
import {
  maybeSendNoWorkFirstHitAlert,
  type NoWorkAlertResult,
} from './no_work_alert.js';
import {
  maybeUpdateRocketChatStatusFromWorkflowLoop,
  type RocketChatStatusUpdate,
} from './rocketchat_status.js';
import {
  reconcileQueuePositionComments,
  type QueuePositionReconcileResult,
} from './queue_position_comments.js';
import { buildRetryPrompt } from './ticket_runtime.js';
import {
  formatForcedBlockedComment,
  formatWorkerResultComment,
  validateWorkerResult,
} from './worker_result.js';
import {
  dispatchWorkerTurn,
  loadWorkerDelegationState,
  type WorkerRuntimeOptions,
} from './worker_runtime.js';
import { ask, setStage, update } from '../verbs/verbs.js';

export type WorkflowLoopExecution = {
  sessionId: string;
  ticketId: string;
  parsed: WorkerCommandResult | null;
  workerOutput: string;
  outcome: 'applied' | 'mutation_error' | 'delegated_started' | 'delegated_running';
  detail?: string;
};

export type WorkflowLoopControllerResult =
  | { quiet: true; exitCode: number }
  | {
      quiet: false;
      exitCode: number;
      payload: {
        workflowLoop: {
          dryRun: boolean;
          dispatchRunId: string;
          actions: any[];
          execution: WorkflowLoopExecution[];
          noWorkAlert: NoWorkAlertResult | null;
          queuePositionUpdate: QueuePositionReconcileResult | null;
          rocketChatStatusUpdate: RocketChatStatusUpdate | null;
          activeTicketId: string | null;
          mapPath: string;
        };
        autopilot: any;
      };
    };

function buildSessionRoutingWarning(
  action: { sessionId: string; ticketId: string },
  routing?: { sessionKey?: string; sessionId?: string; agentSessionId?: string },
): string | null {
  const sessionKey = String(routing?.sessionKey ?? '').trim();
  if (!sessionKey) return null;

  const expectedSuffix = `:${action.sessionId}`;
  if (sessionKey.endsWith(expectedSuffix)) return null;

  return [
    'session_routing_mismatch',
    `ticketId=${action.ticketId}`,
    `requested_session_id=${action.sessionId}`,
    `effective_session_key=${sessionKey}`,
    routing?.sessionId ? `effective_session_id=${routing.sessionId}` : undefined,
    routing?.agentSessionId ? `agent_session_id=${routing.agentSessionId}` : undefined,
  ]
    .filter(Boolean)
    .join('; ');
}

export async function runWorkflowLoopController(params: {
  adapter: any;
  output: any;
  previousMap: SessionMap;
  dryRun: boolean;
  dispatchRunId: string;
  workerAgentId: string;
  workerRuntimeOptions: WorkerRuntimeOptions;
  mapPath?: string;
}): Promise<WorkflowLoopControllerResult> {
  const { adapter, output, previousMap, dryRun, dispatchRunId, workerAgentId, workerRuntimeOptions } = params;
  const plan = buildWorkflowLoopPlan({ autopilotOutput: output, previousMap, now: new Date() });

  const activeCarryForward = Boolean(
    !dryRun &&
      output?.tick?.kind === 'in_progress' &&
      previousMap.active?.ticketId &&
      previousMap.active.ticketId === plan.activeTicketId
  );

  const execution: WorkflowLoopExecution[] = [];
  let noWorkAlert: NoWorkAlertResult | null = null;
  let rocketChatStatusUpdate: RocketChatStatusUpdate | null = null;
  let queuePositionUpdate: QueuePositionReconcileResult | null = null;

  const recordCompletedWorkDuration = (ticketId: string, completedAt: Date): void => {
    const entry = plan.map.sessionsByTicket?.[ticketId];
    const startedAtIso = entry?.workStartedAt;
    if (!startedAtIso) return;
    const startedMs = Date.parse(startedAtIso);
    const endedMs = completedAt.getTime();
    if (!Number.isFinite(startedMs) || endedMs <= startedMs) return;
    const durationMs = endedMs - startedMs;
    const queueState =
      plan.map.queuePosition ??
      (plan.map.queuePosition = {
        commentsByTicket: {},
        recentCompletionDurationsMs: [],
      });
    const samples = Array.isArray(queueState.recentCompletionDurationsMs)
      ? queueState.recentCompletionDurationsMs
      : [];
    queueState.recentCompletionDurationsMs = [...samples, durationMs].slice(-3);
  };

  const applyWorkerOutput = async (
    action: { sessionId: string; ticketId: string; projectId?: string },
    workerOutput: string,
    detailPrefix?: string,
    routing?: { sessionKey?: string; sessionId?: string; agentSessionId?: string },
  ): Promise<void> => {
    let payload = workerOutput;
    let validation = validateWorkerResult(payload);
    let retryCount = 0;
    const routingWarning = buildSessionRoutingWarning(action, routing);
    if (routingWarning) {
      console.warn(`[kwf][warn] ${routingWarning}`);
    }

    while (!validation.ok && retryCount < 2) {
      retryCount += 1;
      const retry = await dispatchWorkerTurn({
        ticketId: action.ticketId,
        projectId: action.projectId,
        dispatchRunId,
        agentId: workerAgentId,
        sessionId: action.sessionId,
        text: buildRetryPrompt(validation.errors),
        thinking: 'low',
      }, workerRuntimeOptions);

      if (retry.kind === 'delegated') {
        markSessionInProgress(plan.map, action.ticketId, new Date());
        execution.push({
          sessionId: action.sessionId,
          ticketId: action.ticketId,
          parsed: null,
          workerOutput: retry.notice,
          outcome: 'delegated_started',
          detail: routingWarning
            ? `source=retry-request; ticket_notified=false; ${routingWarning}`
            : 'source=retry-request; ticket_notified=false',
        });
        return;
      }

      payload = retry.workerOutput;
      validation = validateWorkerResult(payload);
    }

    let parsed: WorkerCommandResult;
    let detail: string;

    if (!validation.ok) {
      const fallbackText = formatForcedBlockedComment(validation.errors);
      parsed = { kind: 'blocked', text: fallbackText };
      detail = `decision=blocked; reason=validation_failed_after_retries; retryCount=${retryCount}; errors=${validation.errors.length}`;
    } else if (validation.value.decision === 'completed') {
      parsed = { kind: 'completed', result: formatWorkerResultComment(validation.value) };
      detail = `decision=completed; retryCount=${retryCount}`;
    } else if (validation.value.decision === 'uncertain') {
      parsed = { kind: 'uncertain', text: formatWorkerResultComment(validation.value) };
      detail = `decision=uncertain; retryCount=${retryCount}`;
    } else {
      parsed = { kind: 'blocked', text: formatWorkerResultComment(validation.value) };
      detail = `decision=blocked; retryCount=${retryCount}`;
    }

    const workerLinks = validation.ok ? validation.value.links : undefined;

    try {
      if (parsed.kind === 'completed') {
        let commentText = parsed.result;
        if (typeof adapter.getStakeholderMentions === 'function') {
          const mentions: string[] = await adapter.getStakeholderMentions(action.ticketId);
          if (mentions.length > 0) {
            commentText += `\n\ncc ${mentions.join(' ')} - ready for review.`;
          }
        }
        await update(adapter, action.ticketId, commentText);
        await setStage(adapter, action.ticketId, 'stage:in-review');
      } else {
        let askText = parsed.text;
        if (typeof adapter.getStakeholderMentions === 'function') {
          const mentions: string[] = await adapter.getStakeholderMentions(action.ticketId);
          if (mentions.length > 0) {
            const verb = parsed.kind === 'blocked' ? 'blocked, needs input' : 'needs clarification';
            askText += `\n\ncc ${mentions.join(' ')} - ${verb}.`;
          }
        }
        await ask(adapter, action.ticketId, askText);
      }

      if (Array.isArray(workerLinks) && workerLinks.length > 0 && typeof adapter.addLinks === 'function') {
        await adapter.addLinks(action.ticketId, workerLinks);
      }

      const appliedAt = new Date();
      if (parsed.kind === 'completed') {
        recordCompletedWorkDuration(action.ticketId, appliedAt);
      }
      applyWorkerCommandToSessionMap(plan.map, action.ticketId, parsed, appliedAt);
      execution.push({
        sessionId: action.sessionId,
        ticketId: action.ticketId,
        parsed,
        workerOutput: payload,
        outcome: 'applied',
        detail: [detailPrefix, detail, routingWarning].filter(Boolean).join('; '),
      });
    } catch (err: any) {
      execution.push({
        sessionId: action.sessionId,
        ticketId: action.ticketId,
        parsed,
        workerOutput: payload,
        outcome: 'mutation_error',
        detail: err?.message ?? String(err),
      });
      throw err;
    }
  };

  if (!dryRun) {
    if (plan.actions.some((action) => action.kind === 'work')) {
      await saveSessionMap(plan.map);
    }

    for (const action of plan.actions) {
      if (action.kind === 'work') {
        const delegationState = await loadWorkerDelegationState(action.sessionId, action.ticketId, workerRuntimeOptions);
        if (delegationState.kind === 'running') {
          markSessionInProgress(plan.map, action.ticketId, new Date());
          execution.push({
            sessionId: action.sessionId,
            ticketId: action.ticketId,
            parsed: null,
            workerOutput: '',
            outcome: 'delegated_running',
            detail: `background_started_at=${delegationState.meta.startedAt}`,
          });
          continue;
        }

        if (delegationState.kind === 'completed') {
          await applyWorkerOutput(action, delegationState.workerOutput, 'source=background-delegation', delegationState.routing);
          continue;
        }
      }

      const dispatched = await dispatchWorkerTurn({
        ticketId: action.ticketId,
        projectId: action.projectId,
        dispatchRunId,
        agentId: workerAgentId,
        sessionId: action.sessionId,
        text: action.text,
        thinking: 'high',
      }, workerRuntimeOptions);

      if (action.kind !== 'work') continue;

      if (dispatched.kind === 'delegated') {
        markSessionInProgress(plan.map, action.ticketId, new Date());
        execution.push({
          sessionId: action.sessionId,
          ticketId: action.ticketId,
          parsed: null,
          workerOutput: dispatched.notice,
          outcome: 'delegated_started',
          detail: 'source=sync-timeout; ticket_notified=false',
        });
        continue;
      }

      await applyWorkerOutput(action, dispatched.workerOutput, undefined, dispatched.routing);
    }
  }

  noWorkAlert = await maybeSendNoWorkFirstHitAlert({
    output,
    previousMap,
    map: plan.map,
    dryRun,
  });

  try {
    queuePositionUpdate = await reconcileQueuePositionComments({
      adapter,
      map: plan.map,
      dryRun,
    });
  } catch (err: any) {
    queuePositionUpdate = {
      outcome: 'error',
      queuedTickets: 0,
      activeOffset: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      errors: [err?.message ?? String(err)],
    };
  }

  rocketChatStatusUpdate = await maybeUpdateRocketChatStatusFromWorkflowLoop({
    output,
    previousMap,
    map: plan.map,
    dryRun,
  });

  if (!dryRun) {
    await saveSessionMap(plan.map);

    if (
      shouldQuietPollAfterCarryForward({
        activeCarryForward,
        executionOutcomes: execution.map((x) => x.outcome),
      })
    ) {
      return { quiet: true, exitCode: 0 };
    }
  }

  return {
    quiet: false,
    exitCode: 0,
    payload: {
      workflowLoop: {
        dryRun,
        dispatchRunId,
        actions: plan.actions,
        execution,
        noWorkAlert,
        queuePositionUpdate,
        rocketChatStatusUpdate,
        activeTicketId: plan.activeTicketId,
        mapPath: params.mapPath ?? '.tmp/kwf-session-map.json',
      },
      autopilot: output,
    },
  };
}
