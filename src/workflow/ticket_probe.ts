import * as fs from 'node:fs/promises';

import { CANONICAL_STAGE_KEYS, type StageKey } from '../stage.js';
import { loadConfigFromFile } from '../config.js';
import { PlaneAdapter } from '../adapters/plane.js';

type ProbeAdapter = {
  name(): string;
  listIdsByStage(stage: StageKey): Promise<string[]>;
  getWorkItem(id: string): Promise<{
    id: string;
    projectId?: string;
    identifier?: string;
    title: string;
    url?: string;
    stage: StageKey;
    body?: string;
    labels: string[];
    assignees?: Array<{ id?: string; username?: string; name?: string } | string>;
    updatedAt?: Date;
  }>;
  listComments(
    id: string,
    opts: { limit?: number; newestFirst: boolean; includeInternal: boolean },
  ): Promise<Array<{ id: string; body: string; createdAt?: Date; author?: { id?: string; username?: string; name?: string } }>>;
  listAttachments(id: string): Promise<Array<{ filename?: string; url?: string }>>;
  listLinkedWorkItems(id: string): Promise<Array<{ id?: string; title?: string; relation?: string; url?: string }>>;
};

export type TicketProbe = {
  ticket: {
    id: string;
    projectId?: string;
    identifier?: string;
    title: string;
    stage: StageKey;
    url?: string;
    labels: string[];
    assigneeCount: number;
    attachmentCount: number;
    linkedCount: number;
    commentCount: number;
  };
  duplicateKeywords: string[];
  likelyDuplicates: Array<{
    id: string;
    identifier?: string;
    title: string;
    stage: StageKey;
    url?: string;
    score: number;
    sharedKeywords: string[];
  }>;
  recentHumanComments: Array<{
    id: string;
    createdAt?: string;
    author?: string;
    body: string;
  }>;
  recentWorkerComments: Array<{
    id: string;
    createdAt?: string;
    author?: string;
    body: string;
  }>;
  verificationHints: string[];
};

const DEFAULT_CONFIG_PATH = 'config/kanban-workflow.json';
const STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'there', 'their', 'about', 'after', 'before', 'being',
  'into', 'your', 'when', 'where', 'which', 'what', 'while', 'were', 'they', 'them', 'then',
  'than', 'todo', 'done', 'wip', 'ticket', 'tickets', 'issue', 'issues', 'task', 'tasks',
  'implement', 'investigate', 'fix', 'make', 'does', 'dont', 'doesnt', 'cant', 'would', 'should',
  'could', 'been', 'still', 'just', 'more', 'need', 'needs', 'using', 'used', 'into', 'back',
  'comment', 'comments', 'plane', 'jules', 'workflow',
]);

function trimOneLine(raw: string | undefined): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

function trimBody(raw: string | undefined, max = 280): string {
  const text = trimOneLine(raw);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function isWorkerGeneratedComment(body: string): boolean {
  const text = trimOneLine(body).toLowerCase();
  return (
    text.startsWith('worker decision:') ||
    text.startsWith('there are ') ||
    text.includes('no explicit handoff is needed')
  );
}

export function extractDuplicateKeywords(input: { title?: string; body?: string }): string[] {
  const text = `${trimOneLine(input.title)} ${trimOneLine(input.body)}`.toLowerCase();
  const counts = new Map<string, number>();
  for (const token of text.split(/[^a-z0-9]+/g)) {
    if (token.length < 4) continue;
    if (/^\d+$/.test(token)) continue;
    if (STOP_WORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 8)
    .map(([token]) => token);
}

function sharedKeywordsForCandidate(keywords: string[], candidate: { title?: string; body?: string; identifier?: string }): string[] {
  const haystack = `${trimOneLine(candidate.identifier)} ${trimOneLine(candidate.title)} ${trimOneLine(candidate.body)}`.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword));
}

export function scoreDuplicateCandidate(params: {
  keywords: string[];
  currentId: string;
  candidate: { id: string; title?: string; body?: string; identifier?: string };
}): { score: number; sharedKeywords: string[] } {
  if (params.candidate.id === params.currentId) return { score: 0, sharedKeywords: [] };
  const sharedKeywords = sharedKeywordsForCandidate(params.keywords, params.candidate);
  let score = sharedKeywords.length;
  if (trimOneLine(params.candidate.identifier)) score += 0.5;
  if (trimOneLine(params.candidate.title).toLowerCase().includes(trimOneLine(params.keywords[0]).toLowerCase())) {
    score += 0.5;
  }
  return { score, sharedKeywords };
}

async function loadAdapter(configPath = DEFAULT_CONFIG_PATH): Promise<ProbeAdapter> {
  const config = await loadConfigFromFile({
    fs: {
      readFile: (filePath: string, _encoding: 'utf-8') => fs.readFile(filePath, 'utf8'),
      writeFile: async () => { throw new Error('ticket_probe does not support writeFile'); },
      mkdir: async () => { throw new Error('ticket_probe does not support mkdir'); },
    },
    path: configPath,
  });

  if (config.adapter.kind !== 'plane') {
    throw new Error(`Unsupported adapter for ticket_probe: ${config.adapter.kind}`);
  }

  return new PlaneAdapter({
    workspaceSlug: config.adapter.workspaceSlug,
    projectId: config.adapter.projectId,
    projectIds: config.adapter.projectIds,
    orderField: config.adapter.orderField,
    stageMap: config.adapter.stageMap,
  }) as ProbeAdapter;
}

export async function buildTicketProbe(params: {
  adapter: ProbeAdapter;
  ticketId: string;
}): Promise<TicketProbe> {
  const item = await params.adapter.getWorkItem(params.ticketId);
  const [comments, attachments, linked] = await Promise.all([
    params.adapter.listComments(params.ticketId, { limit: 12, newestFirst: true, includeInternal: true }),
    params.adapter.listAttachments(params.ticketId),
    params.adapter.listLinkedWorkItems(params.ticketId),
  ]);

  const duplicateKeywords = extractDuplicateKeywords({
    title: item.title,
    body: item.body,
  });

  const candidateIds = new Set<string>();
  for (const stage of CANONICAL_STAGE_KEYS) {
    for (const id of await params.adapter.listIdsByStage(stage)) {
      if (id !== params.ticketId) candidateIds.add(id);
    }
  }

  const candidateDetails = await Promise.all(
    [...candidateIds].slice(0, 80).map(async (id) => {
      try {
        return await params.adapter.getWorkItem(id);
      } catch {
        return null;
      }
    }),
  );

  const likelyDuplicates = candidateDetails
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .map((candidate) => {
      const { score, sharedKeywords } = scoreDuplicateCandidate({
        keywords: duplicateKeywords,
        currentId: params.ticketId,
        candidate,
      });
      return {
        id: candidate.id,
        identifier: candidate.identifier,
        title: candidate.title,
        stage: candidate.stage,
        url: candidate.url,
        score,
        sharedKeywords,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    })
    .slice(0, 5);

  const recentHumanComments = comments
    .filter((comment) => !isWorkerGeneratedComment(comment.body))
    .slice(0, 5)
    .map((comment) => ({
      id: comment.id,
      createdAt: comment.createdAt?.toISOString(),
      author: trimOneLine(comment.author?.name || comment.author?.username || comment.author?.id),
      body: trimBody(comment.body),
    }));

  const recentWorkerComments = comments
    .filter((comment) => isWorkerGeneratedComment(comment.body))
    .slice(0, 3)
    .map((comment) => ({
      id: comment.id,
      createdAt: comment.createdAt?.toISOString(),
      author: trimOneLine(comment.author?.name || comment.author?.username || comment.author?.id),
      body: trimBody(comment.body),
    }));

  return {
    ticket: {
      id: item.id,
      projectId: item.projectId,
      identifier: item.identifier,
      title: item.title,
      stage: item.stage,
      url: item.url,
      labels: item.labels,
      assigneeCount: item.assignees?.length ?? 0,
      attachmentCount: attachments.length,
      linkedCount: linked.length,
      commentCount: comments.length,
    },
    duplicateKeywords,
    likelyDuplicates,
    recentHumanComments,
    recentWorkerComments,
    verificationHints: [
      'Start with a duplicate sanity check before implementation.',
      'Prefer recent human comments over old worker-generated comments when deciding what changed.',
      'Use scripts/verification_primitives.sh for compact red/green checks where possible.',
    ],
  };
}

export async function runTicketProbeCli(argv: string[]): Promise<number> {
  let ticketId = '';
  let configPath = DEFAULT_CONFIG_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--ticket-id') {
      ticketId = String(argv[index + 1] ?? '').trim();
      index += 1;
      continue;
    }
    if (arg === '--config') {
      configPath = String(argv[index + 1] ?? '').trim() || DEFAULT_CONFIG_PATH;
      index += 1;
    }
  }

  if (!ticketId) {
    process.stderr.write('ticket_probe requires --ticket-id\n');
    return 2;
  }

  const adapter = await loadAdapter(configPath);
  const probe = await buildTicketProbe({ adapter, ticketId });
  process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
  return 0;
}
