import {
  loadSessionMap,
  saveSessionMap,
  type SessionMap,
} from '../automation/session_dispatcher.js';
import type { StageKey } from '../stage.js';
import type { WorkerRuntimeOptions } from './worker_runtime.js';
import { loadTrackedWorkerRunState } from './worker_runtime.js';
import { runDelegationReconciler, type DelegationReconcileResult } from './delegation_reconciler.js';
import type { WorkflowLifecycleAdapter } from './workflow_loop_ports.js';

export type ActiveRunWatchdogResult = {
  scanned: number;
  reconciled: Array<{
    ticketId: string;
    sessionId: string;
    delegation: DelegationReconcileResult;
  }>;
  staleRequested: Array<{
    ticketId: string;
    sessionId: string;
    requestId: string;
    ageSeconds: number;
  }>;
  staleRunning: Array<{
    ticketId: string;
    sessionId: string;
    runId?: string;
    childSessionKey?: string;
    ageSeconds: number;
    remediated?: boolean;
    stageBefore?: StageKey;
    stageAfter?: StageKey;
  }>;
};

function clearStaleActiveRun(map: SessionMap, ticketId: string, nowIso: string, stageAfter?: StageKey): void {
  const entry = map.sessionsByTicket?.[ticketId];
  if (!entry) return;
  delete entry.activeRun;
  entry.lastSeenAt = nowIso;

  if (stageAfter === 'stage:blocked') {
    entry.lastState = 'blocked';
  } else if (stageAfter === 'stage:in-review') {
    entry.lastState = 'completed';
  } else {
    entry.lastState = 'queued';
  }

  if (map.active?.ticketId === ticketId) {
    delete map.active;
  }
}

function ageSecondsFrom(iso: string | undefined, now: number): number | null {
  const ms = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(ms) || ms > now) return null;
  return Math.floor((now - ms) / 1000);
}

export async function runActiveRunWatchdog(params: {
  adapter: WorkflowLifecycleAdapter & { getWorkItem?(ticketId: string): Promise<any> };
  dispatchRunId: string;
  workerAgentId: string;
  workerRuntimeOptions: WorkerRuntimeOptions;
  requeueTargetStage?: StageKey;
  mapPath?: string;
  now?: Date;
  requestedStaleAfterSeconds?: number;
  runningStaleGraceSeconds?: number;
  remediateStaleRunning?: boolean;
}): Promise<ActiveRunWatchdogResult> {
  const map = await loadSessionMap(params.mapPath);
  const now = params.now ?? new Date();
  const nowMs = now.getTime();
  const requestedStaleAfterSeconds = params.requestedStaleAfterSeconds ?? 120;
  const runningStaleGraceSeconds = params.runningStaleGraceSeconds ?? 120;
  const remediateStaleRunning = params.remediateStaleRunning ?? true;

  const result: ActiveRunWatchdogResult = {
    scanned: 0,
    reconciled: [],
    staleRequested: [],
    staleRunning: [],
  };

  for (const [ticketId, entry] of Object.entries(map.sessionsByTicket ?? {})) {
    if (!entry?.activeRun) continue;
    result.scanned += 1;

    if (entry.activeRun.status === 'spawn_requested') {
      const ageSeconds = ageSecondsFrom(entry.activeRun.sentAt, nowMs);
      if (ageSeconds != null && ageSeconds >= requestedStaleAfterSeconds) {
        result.staleRequested.push({
          ticketId,
          sessionId: entry.sessionId,
          requestId: entry.activeRun.requestId,
          ageSeconds,
        });
      }
      continue;
    }

    if (entry.activeRun.status !== 'started') continue;

    const state = await loadTrackedWorkerRunState(ticketId, entry, params.workerRuntimeOptions);
    if (state.kind === 'completed') {
      const delegation = await runDelegationReconciler({
        adapter: params.adapter,
        ticketId,
        sessionId: entry.sessionId,
        dispatchRunId: `${params.dispatchRunId}:watchdog:${ticketId}`,
        workerAgentId: params.workerAgentId,
        workerRuntimeOptions: params.workerRuntimeOptions,
        requeueTargetStage: params.requeueTargetStage,
        mapPath: params.mapPath,
      });
      result.reconciled.push({
        ticketId,
        sessionId: entry.sessionId,
        delegation,
      });
      continue;
    }

    if (state.kind === 'running') {
      const activeRun = entry.activeRun;
      if (!activeRun || activeRun.status !== 'started') continue;
      const ageSeconds = ageSecondsFrom(entry.activeRun.sentAt, nowMs);
      const staleAfterSeconds = Math.max(0, activeRun.waitTimeoutSeconds + runningStaleGraceSeconds);
      if (ageSeconds != null && ageSeconds >= staleAfterSeconds) {
        let stageBefore: StageKey | undefined;
        let stageAfter: StageKey | undefined;
        let remediated = false;

        if (remediateStaleRunning) {
          const item = typeof params.adapter.getWorkItem === 'function'
            ? await params.adapter.getWorkItem(ticketId).catch(() => undefined)
            : undefined;
          stageBefore = item?.stage as StageKey | undefined;
          const targetStage = params.requeueTargetStage ?? 'stage:todo';

          if (!stageBefore || stageBefore === 'stage:in-progress') {
            await params.adapter.setStage(ticketId, targetStage);
            stageAfter = targetStage;
          } else {
            stageAfter = stageBefore;
          }

          clearStaleActiveRun(map, ticketId, now.toISOString(), stageAfter);
          await saveSessionMap(map, params.mapPath);
          remediated = true;
        }

        result.staleRunning.push({
          ticketId,
          sessionId: entry.sessionId,
          runId: activeRun.runId,
          childSessionKey: activeRun.sessionKey,
          ageSeconds,
          remediated,
          stageBefore,
          stageAfter,
        });
      }
    }
  }

  return result;
}
