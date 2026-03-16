import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOG_PATH = "/var/log/openclaw/kwf-subagent-ended.log";

function summarizeError(err) {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  return String(err);
}

async function logLine(message, extra = undefined) {
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    const line = [
      `[${new Date().toISOString()}]`,
      message,
      extra ? JSON.stringify(extra) : "",
    ].filter(Boolean).join(" ");
    await appendFile(LOG_PATH, `${line}\n`, "utf8");
  } catch {
    // Best-effort only.
  }
}

function isWorkerChildSessionKey(value) {
  return typeof value === "string" && value.startsWith("agent:main:subagent:");
}

function resolveChildSessionKey(event) {
  const direct = typeof event?.targetSessionKey === "string" ? event.targetSessionKey.trim() : "";
  if (direct) return direct;
  const fallback = typeof event?.childSessionKey === "string" ? event.childSessionKey.trim() : "";
  if (fallback) return fallback;
  const nested = typeof event?.target?.sessionKey === "string" ? event.target.sessionKey.trim() : "";
  return nested;
}

async function runNpm(repoDir, args, meta) {
  try {
    const { stdout, stderr } = await execFileAsync("npm", args, { cwd: repoDir });
    if ((stderr ?? "").trim()) {
      await logLine("command-stderr", { ...meta, stderr: String(stderr).trim() });
    }
    if ((stdout ?? "").trim()) {
      await logLine("command-stdout", { ...meta, stdout: String(stdout).trim() });
    }
    return true;
  } catch (err) {
    await logLine("command-failed", {
      ...meta,
      error: summarizeError(err),
      stdout: String(err?.stdout ?? "").trim(),
      stderr: String(err?.stderr ?? "").trim(),
    });
    return false;
  }
}

export default async function kwfSubagentEnded(event) {
  const childSessionKey = resolveChildSessionKey(event);
  if (!isWorkerChildSessionKey(childSessionKey)) {
    return;
  }

  const repoDir = "/root/.openclaw/workspace/skills/kanban-workflow";
  await logLine("subagent-ended", {
    childSessionKey,
    runId: typeof event?.runId === "string" ? event.runId : undefined,
    reason: typeof event?.reason === "string" ? event.reason : undefined,
  });

  await runNpm(
    repoDir,
    [
      "run",
      "-s",
      "kanban-workflow",
      "--",
      "reconcile-subagent-ended",
      "--child-session-key",
      childSessionKey,
    ],
    { kind: "reconcile-subagent-ended", childSessionKey },
  );

  await runNpm(
    repoDir,
    [
      "run",
      "-s",
      "kanban-workflow",
      "--",
      "reconcile-active-runs",
    ],
    { kind: "reconcile-active-runs", childSessionKey },
  );
}
