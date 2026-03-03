import { describe, expect, it } from 'vitest';

import {
  coerceDecisionChoice,
  extractDecisionProbabilities,
  extractWorkerReportFacts,
  formatBlockedComment,
  parseDecisionChoice,
  shouldQuietPollAfterCarryForward,
  summarizeReportForComment,
} from '../src/workflow/decision_policy.js';

describe('workflow decision policy', () => {
  it('coerces completed to blocked when verification is missing', () => {
    const facts = extractWorkerReportFacts(
      [
        'Blockers: resolved',
        'Uncertainties: none',
        'Confidence: 0.9',
      ].join('\n'),
    );

    const out = coerceDecisionChoice({ decision: 'completed', facts, continueCount: 0 });
    expect(out).toBe('blocked');
  });

  it('coerces completed to blocked when blockers are not resolved', () => {
    const facts = extractWorkerReportFacts(
      [
        'Verification: tests passed',
        'Blockers: open dependency',
        'Uncertainties: low',
        'Confidence: 0.8',
      ].join('\n'),
    );

    const out = coerceDecisionChoice({ decision: 'completed', facts, continueCount: 0 });
    expect(out).toBe('blocked');
  });

  it('coerces continue to blocked after continue cap is reached', () => {
    const facts = extractWorkerReportFacts(
      [
        'Verification: tests passed',
        'Blockers: resolved',
        'Uncertainties: low',
        'Confidence: 0.8',
      ].join('\n'),
    );

    const out = coerceDecisionChoice({ decision: 'continue', facts, continueCount: 2 });
    expect(out).toBe('blocked');
  });

  it('quiet-polls only when carry-forward and all execution outcomes are delegated_running', () => {
    expect(
      shouldQuietPollAfterCarryForward({
        activeCarryForward: true,
        executionOutcomes: ['delegated_running', 'delegated_running'],
      }),
    ).toBe(true);

    expect(
      shouldQuietPollAfterCarryForward({
        activeCarryForward: true,
        executionOutcomes: ['delegated_running', 'applied'],
      }),
    ).toBe(false);

    expect(
      shouldQuietPollAfterCarryForward({
        activeCarryForward: true,
        executionOutcomes: [],
      }),
    ).toBe(false);
  });

  it('parses only strict one-word decisions (or structured json)', () => {
    expect(parseDecisionChoice('continue')).toBe('continue');
    expect(parseDecisionChoice('  "blocked"  ')).toBe('blocked');
    expect(parseDecisionChoice('I think continue')).toBeNull();
    expect(parseDecisionChoice('not blocked, continue')).toBeNull();
    expect(parseDecisionChoice('{"decision":"completed"}')).toBe('completed');
  });

  it('summarizes report comments to a few plain sentences', () => {
    const report = [
      '# Status Report',
      '',
      '## Verification Evidence',
      '- Verified no-work alert defaults in code.',
      '- Ran targeted tests and they passed.',
      '',
      '## Blockers',
      '| Blocker | Status | Details |',
      '|---|---|---|',
      '| SSH | OPEN | Access unavailable |',
      '',
      '## Uncertainties',
      '- Uncertainty: none.',
      '',
      '## Confidence',
      '0.9',
      '',
      '## Extra',
      'This sentence should not appear when limited to three sentences.',
    ].join('\n');

    const out = summarizeReportForComment(report, 420);
    expect(out).not.toContain('\n');
    const sentenceCount = out.split(/[.!?]\s+/).filter(Boolean).length;
    expect(sentenceCount).toBeLessThanOrEqual(3);
    // Summaries should prioritize actionable sections (Blockers/Questions) when present.
    expect(out).toContain('SSH');
    expect(out).toContain('OPEN');
    expect(out).toContain('Access unavailable');
  });

  it('extracts optional worker decision probabilities from free-form output', () => {
    const report = [
      'Status: did execution and verified current output.',
      'continue: 55%',
      'blocked: 0.35',
      'completed: 10%',
    ].join('\n');

    expect(extractDecisionProbabilities(report)).toEqual({
      continue: 0.55,
      blocked: 0.35,
      completed: 0.1,
    });
  });

  it('formats blocked comments with mandatory human-unblock contract', () => {
    const report = [
      'Verification: listed Plane states in two projects.',
      'Blockers: OPEN cannot hard-delete _DELETED_* states with current API permission.',
      'Ask: please confirm whether soft-deleted states are acceptable.',
      'Confidence: 0.8',
    ].join('\n');
    const facts = extractWorkerReportFacts(report);
    const out = formatBlockedComment(report, facts, 900);

    expect(out).toContain('BLOCKED');
    expect(out).toContain('Blocked because:');
    expect(out).toContain('Human action required:');
    expect(out).toContain('Evidence:');
    expect(out).toContain('Next action after unblock:');
  });
});
