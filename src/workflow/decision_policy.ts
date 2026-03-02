export type DecisionChoice = 'continue' | 'blocked' | 'completed';

export type WorkerReportFacts = {
  hasVerification: boolean;
  hasBlockers: boolean;
  hasResolvedBlockers: boolean;
  hasUncertainties: boolean;
  hasConfidence: boolean;
  missing: string[];
};

export function extractWorkerReportFacts(report: string): WorkerReportFacts {
  const text = String(report ?? '');
  const lower = text.toLowerCase();

  const hasVerification =
    /\bverification\b/.test(lower) ||
    /\bverified\b/.test(lower) ||
    /\btests?\b/.test(lower) ||
    /\bvalidation\b/.test(lower);

  const hasBlockerSignal = /\bblocker(s)?\b/.test(lower) || /\bblocked\b/.test(lower) || /\bdependency\b/.test(lower);
  const hasOpenBlockers = hasBlockerSignal && /\bopen\b/.test(lower);
  const hasResolvedBlockers = hasBlockerSignal && /\bresolved\b/.test(lower);
  const hasBlockers = hasOpenBlockers || hasResolvedBlockers;

  const hasUncertainties =
    /\buncertaint(y|ies)\b/.test(lower) ||
    /\buncertain\b/.test(lower) ||
    /\brisk(s)?\b/.test(lower) ||
    /\bquestion(s)?\b/.test(lower);

  const hasConfidence = /\bconfidence\b/.test(lower) && /\b(0(\.\d+)?|1(\.0+)?)\b/.test(lower);

  const missing: string[] = [];
  if (!hasVerification) missing.push('verification evidence');
  if (!hasBlockers) missing.push('blockers with open/resolved status');
  if (!hasUncertainties) missing.push('uncertainties');
  if (!hasConfidence) missing.push('confidence (0.0..1.0)');

  return { hasVerification, hasBlockers, hasResolvedBlockers, hasUncertainties, hasConfidence, missing };
}

export function parseDecisionChoice(raw: string): DecisionChoice | null {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/\bcompleted\b/.test(text)) return 'completed';
  if (/\bblocked\b/.test(text)) return 'blocked';
  if (/\bcontinue\b/.test(text)) return 'continue';
  return null;
}

export function coerceDecisionChoice(input: {
  decision: DecisionChoice | null;
  facts: WorkerReportFacts;
  continueCount: number;
}): DecisionChoice {
  let decision: DecisionChoice = input.decision ?? 'blocked';
  if (input.facts.missing.length > 0 && decision !== 'blocked') {
    decision = 'blocked';
  }
  if (decision === 'completed' && !(input.facts.hasVerification && input.facts.hasResolvedBlockers)) {
    decision = 'blocked';
  }
  if (decision === 'continue' && input.continueCount >= 2) {
    decision = 'blocked';
  }
  return decision;
}

export function summarizeReportForComment(report: string, maxChars = 1200): string {
  const compact = String(report ?? '').trim().replace(/\s+/g, ' ');
  if (!compact) return 'No report details provided.';
  return compact.length > maxChars ? `${compact.slice(0, maxChars).trimEnd()}...` : compact;
}

export function shouldQuietPollAfterCarryForward(params: {
  activeCarryForward: boolean;
  executionOutcomes: Array<'applied' | 'mutation_error' | 'delegated_started' | 'delegated_running'>;
}): boolean {
  if (!params.activeCarryForward) return false;
  if (params.executionOutcomes.length === 0) return false;
  return params.executionOutcomes.every((x) => x === 'delegated_running');
}
