import { describe, expect, it } from 'vitest';

import { parseWorkerOutputFromAgentCall } from '../src/workflow/agent_io.js';

describe('agent io parsing', () => {
  it('extracts text from JSON payloads and keeps stderr separate', () => {
    const stdout = JSON.stringify({
      result: {
        payloads: [
          { text: 'Line 1' },
          { text: 'Line 2' },
        ],
      },
    });
    const stderr = 'warning: noisy transport layer';

    const parsed = parseWorkerOutputFromAgentCall(stdout, stderr);

    expect(parsed.workerOutput).toBe('Line 1\nLine 2');
    expect(parsed.stderr).toBe(stderr);
    expect(parsed.ok).toBe(true);
    expect(parsed.workerOutput).not.toContain('warning:');
  });

  it('falls back to raw stdout when output is not JSON', () => {
    const parsed = parseWorkerOutputFromAgentCall('plain markdown report', '');
    expect(parsed.workerOutput).toBe('plain markdown report');
    expect(parsed.raw).toBe('plain markdown report');
    expect(parsed.ok).toBe(true);
  });

  it('marks non-ok agent json responses as errors', () => {
    const parsed = parseWorkerOutputFromAgentCall(
      JSON.stringify({ status: 'error', error: { message: 'model unavailable' } }),
      '',
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('model unavailable');
  });
});
