export type AgentCallParsed = {
  workerOutput: string;
  raw: string;
  stderr: string;
};

export function parseWorkerOutputFromAgentCall(stdoutRaw: unknown, stderrRaw: unknown): AgentCallParsed {
  const raw = String(stdoutRaw ?? '').trim();
  const stderr = String(stderrRaw ?? '').trim();
  let workerOutput = raw;

  try {
    const parsed = JSON.parse(raw);
    const payloads: any[] = Array.isArray(parsed?.result?.payloads) ? parsed.result.payloads : [];
    const asText = payloads
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter((x) => x.trim().length > 0)
      .join('\n');
    if (asText.trim()) workerOutput = asText;
  } catch {
    // fallback to raw stdout
  }

  return { workerOutput: workerOutput.trim(), raw, stderr };
}
