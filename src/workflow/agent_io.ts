export type AgentCallParsed = {
  workerOutput: string;
  raw: string;
  stderr: string;
  ok: boolean;
  error?: string;
};

export function parseWorkerOutputFromAgentCall(stdoutRaw: unknown, stderrRaw: unknown): AgentCallParsed {
  const raw = String(stdoutRaw ?? '').trim();
  const stderr = String(stderrRaw ?? '').trim();
  let workerOutput = raw;
  let ok = true;
  let error: string | undefined;

  try {
    const parsed = JSON.parse(raw);
    const status = typeof parsed?.status === 'string' ? String(parsed.status).toLowerCase() : undefined;
    if (status && status !== 'ok') {
      ok = false;
      const msg =
        parsed?.error?.message ??
        parsed?.error ??
        parsed?.message ??
        parsed?.summary ??
        `agent status=${status}`;
      error = String(msg);
    }
    const payloads: any[] = Array.isArray(parsed?.result?.payloads) ? parsed.result.payloads : [];
    const asText = payloads
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter((x) => x.trim().length > 0)
      .join('\n');
    if (asText.trim()) workerOutput = asText;
  } catch {
    // fallback to raw stdout
  }

  return { workerOutput: workerOutput.trim(), raw, stderr, ok, error };
}
