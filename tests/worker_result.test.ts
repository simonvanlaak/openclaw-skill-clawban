import { describe, expect, it } from 'vitest';

import {
  formatWorkerResultComment,
  validateWorkerResult,
} from '../src/workflow/worker_result.js';

describe('worker_result schema', () => {
  it('accepts valid completed payload', () => {
    const payload = JSON.stringify({
      decision: 'completed',
      completed_steps: ['Implemented strict schema validation and updated workflow routing.'],
      clarification_questions: [],
      blocker_resolve_requests: [],
      solution_summary: 'The worker finished implementation and all requested checks were satisfied.',
      evidence: ['https://nextcloud.example.com/s/abc123-work-report-link'],
    });
    const parsed = validateWorkerResult(payload);
    expect(parsed.ok).toBe(true);
  });

  it('returns all schema errors for invalid payload', () => {
    const payload = JSON.stringify({
      decision: 'blocked',
      completed_steps: [],
      clarification_questions: ['too short'],
      blocker_resolve_requests: [],
      evidence: ['too short'],
      solution_summary: 'too short',
    });
    const parsed = validateWorkerResult(payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.length).toBeGreaterThan(1);
    expect(parsed.errors.some((error) => error.includes('completed_steps'))).toBe(true);
    expect(parsed.errors.some((error) => error.includes('clarification_questions'))).toBe(true);
    expect(parsed.errors.some((error) => error.includes('blocker_resolve_requests'))).toBe(true);
    expect(parsed.errors.some((error) => error.includes('evidence'))).toBe(true);
    expect(parsed.errors.some((error) => error.includes('solution_summary'))).toBe(true);
  });

  it('requires clarification questions for uncertain decision', () => {
    const payload = JSON.stringify({
      decision: 'uncertain',
      completed_steps: ['Reached a dependency boundary and documented current state precisely.'],
      clarification_questions: [],
      blocker_resolve_requests: [],
      evidence: [],
    });
    const parsed = validateWorkerResult(payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((error) => error.includes('clarification_questions'))).toBe(true);
  });

  it('formats uncertain decision comment with questions section', () => {
    const payload = JSON.stringify({
      decision: 'uncertain',
      completed_steps: ['Investigated API behavior and isolated ambiguous requirement behavior.'],
      clarification_questions: ['Should we persist validation failures to ticket comments or logs only?'],
      blocker_resolve_requests: [],
      evidence: [],
    });
    const parsed = validateWorkerResult(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const comment = formatWorkerResultComment(parsed.value);
    expect(comment).toContain('Worker decision: uncertain');
    expect(comment).toContain('Clarification questions:');
    expect(comment).toContain('1. Investigated API behavior and isolated ambiguous requirement behavior.');
    expect(comment).toContain('1. Should we persist validation failures to ticket comments or logs only?');
  });
});
