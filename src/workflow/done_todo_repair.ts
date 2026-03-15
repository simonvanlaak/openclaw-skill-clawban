import { execa } from 'execa';

type RepairTicket = {
  ticketId: string;
  projectId: string;
  sequenceId?: number;
  title: string;
  todoActivityAt?: string;
};

export type DoneTodoRepairResult = {
  repaired: RepairTicket[];
  scannedTodoTickets: number;
  dryRun: boolean;
};

function planeBaseUrl(): string {
  return (process.env.PLANE_BASE_URL || 'https://api.plane.so').replace(/\/$/, '');
}

function normalizeStateValue(value: unknown, stateNameById: Map<string, string>): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    return stateNameById.get(value) ?? value;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name : undefined;
    const id = typeof obj.id === 'string' ? obj.id : undefined;
    return name ?? (id ? stateNameById.get(id) : undefined);
  }
  return undefined;
}

async function fetchJson(url: string): Promise<any> {
  const apiKey = String(process.env.PLANE_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('PLANE_API_KEY is required for Plane repair commands');

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Plane API failed: HTTP ${res.status} ${text}`);
  }
  return res.json();
}

async function loadStates(workspaceSlug: string, projectId: string): Promise<Map<string, string>> {
  const url = `${planeBaseUrl()}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/states/`;
  const payload = await fetchJson(url);
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  return new Map(
    rows
      .map((row: any) => [String(row?.id ?? ''), String(row?.name ?? '')] as const)
      .filter((entry: readonly [string, string]): entry is readonly [string, string] => Boolean(entry[0] && entry[1])),
  );
}

function currentStateName(issue: any, stateNameById: Map<string, string>): string | undefined {
  const detail = issue?.state_detail;
  if (detail && typeof detail === 'object' && typeof detail.name === 'string') return detail.name;
  const state = issue?.state;
  if (state && typeof state === 'object' && typeof state.name === 'string') return state.name;
  if (typeof state === 'string') return stateNameById.get(state) ?? state;
  return undefined;
}

async function moveIssueToDone(projectId: string, ticketId: string, doneStateId: string): Promise<void> {
  await execa('plane', ['-f', 'json', 'issues', 'update', '-p', projectId, '--state', doneStateId, ticketId], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

export async function runDoneTodoRepair(params: {
  workspaceSlug: string;
  projectIds: string[];
  actorId?: string;
  dryRun?: boolean;
  sinceHours?: number;
}): Promise<DoneTodoRepairResult> {
  const dryRun = Boolean(params.dryRun);
  const sinceHours = Number.isFinite(params.sinceHours) ? Math.max(0, Number(params.sinceHours)) : 24;
  const cutoffMs = Date.now() - sinceHours * 60 * 60 * 1000;
  const repaired: RepairTicket[] = [];
  let scannedTodoTickets = 0;

  for (const projectId of params.projectIds) {
    const stateNameById = await loadStates(params.workspaceSlug, projectId);
    const doneStateId = [...stateNameById.entries()].find(([, name]) => name.trim().toLowerCase() === 'done')?.[0];
    if (!doneStateId) continue;

    const issuesUrl = `${planeBaseUrl()}/api/v1/workspaces/${params.workspaceSlug}/projects/${projectId}/work-items/`;
    const issuesPayload = await fetchJson(issuesUrl);
    const issues = Array.isArray(issuesPayload?.results) ? issuesPayload.results : [];

    for (const issue of issues) {
      if (currentStateName(issue, stateNameById)?.trim().toLowerCase() !== 'todo') continue;
      scannedTodoTickets += 1;

      const ticketId = String(issue?.id ?? '');
      if (!ticketId) continue;

      const activitiesUrl = `${planeBaseUrl()}/api/v1/workspaces/${params.workspaceSlug}/projects/${projectId}/work-items/${ticketId}/activities/`;
      const activitiesPayload = await fetchJson(activitiesUrl);
      const activities = Array.isArray(activitiesPayload?.results) ? activitiesPayload.results : [];

      const transition = activities.find((activity: any) => {
        if (String(activity?.field ?? '').toLowerCase() !== 'state') return false;
        if (params.actorId && String(activity?.actor ?? '') !== params.actorId) return false;
        if (sinceHours > 0) {
          const createdAtMs = Date.parse(String(activity?.created_at ?? ''));
          if (Number.isFinite(createdAtMs) && createdAtMs < cutoffMs) return false;
        }

        const oldValue = normalizeStateValue(activity?.old_value, stateNameById)?.trim().toLowerCase();
        const newValue = normalizeStateValue(activity?.new_value, stateNameById)?.trim().toLowerCase();
        return oldValue === 'done' && newValue === 'todo';
      });

      if (!transition) continue;

      const match: RepairTicket = {
        ticketId,
        projectId,
        sequenceId: Number.isFinite(Number(issue?.sequence_id)) ? Number(issue.sequence_id) : undefined,
        title: String(issue?.name ?? ticketId),
        todoActivityAt: typeof transition?.created_at === 'string' ? transition.created_at : undefined,
      };
      repaired.push(match);

      if (!dryRun) {
        await moveIssueToDone(projectId, ticketId, doneStateId);
      }
    }
  }

  return {
    repaired,
    scannedTodoTickets,
    dryRun,
  };
}
