# Kanban Workflow Requirements (active baseline)

Status: active
Scope: Plane-only
Last updated: 2026-03-02

This document is the authoritative requirements baseline moving forward.

## 1) Product direction

- Kanban Workflow is Plane-only.
- Remove/ignore GitHub, Linear, and Planka requirements for now.
- Workflow is autopilot-first.
- Direct manual CLI mutation commands are removed from user-facing flow.

## 2) Canonical stage model

Canonical stages (only stages considered by the workflow):

- `stage:todo`
- `stage:blocked`
- `stage:in-progress`
- `stage:in-review`

Done/closed remains platform-specific and outside the canonical set.

## 3) Setup

Setup is non-interactive and flags-only.

Command:
- `kanban-workflow setup --adapter plane ...`

Required flags:
- `--adapter plane`
- `--force` required to overwrite existing `config/kanban-workflow.json`
- `--map-backlog <plane-state-name>`
- `--map-blocked <plane-state-name>`
- `--map-in-progress <plane-state-name>`
- `--map-in-review <plane-state-name>`
- `--plane-workspace-slug <slug>`
- `--plane-scope all-projects`

Optional flags:
- `--plane-order-field <field>`
- `--autopilot-cron-expr <cron>`
- `--autopilot-cron-tz <tz>`
- `--autopilot-install-cron`
- `--autopilot-requeue-target-stage <stage key>`

Setup validations:
- Fail hard if Plane CLI/auth prerequisites fail.
- Validate read prerequisites for `show` and selection prerequisites for `workflow-loop`.
- Validations are read-only.

Config:
- Single config profile only.
- Stored at `config/kanban-workflow.json`.
- Plane scope is all projects; mapped state names must remain consistent across monitored projects.

## 4) Command surface (user-facing)

Supported user-facing commands:
- `setup`
- `show --id <ticket-id>`
- `create --project-id <uuid> --title "..." [--body "..."]`
- `workflow-loop [--dry-run]`

Not part of user-facing flow:
- Direct manual mutation commands (`start`, `update`, `ask`, `complete`) are removed.
- Any legacy human-invoked mutation aliases are out of scope.

## 5) Core behavior requirements

### 5.1 `show`

`show` returns full Plane ticket context for implementation work.

Required fields:
- id
- title
- URL (if available)
- canonical stage
- full description/body (best available full text)
- labels (if available)
- assignees
- updatedAt
- last 10 comments (newest first), including internal/private comments when available

Each comment entry includes:
- author (best available identity fields)
- timestamp
- content

Optional fields (when available from Plane surfaces):
- attachments
- linked/related ticket summaries

Behavior for optional fields:
- Missing optional fields are silent; do not error when attachment/link data is unavailable.

### 5.2 `create`

- Input: project id + title + Markdown body.
- `--project-id` is mandatory.
- Create in Plane backlog stage (`stage:todo`) via explicit stage enforcement.
- Must assign to the current authenticated user.
- Fail hard if self-resolution fails.
- Fail hard if assignment fails.
- Does not auto-start.
- Failure messages should be short and direct.

### 5.3 Comment/stage mutation semantics

Workflow-level mutation outcomes remain:
- progress update comment (no stage change)
- clarification/block comment + move to `stage:blocked`
- completion comment + move to `stage:in-review`
- start/move to `stage:in-progress`

These are automation/engine actions, not direct user-facing CLI commands.

## 6) Workflow Loop

### 6.1 Autopilot-first operation

`workflow-loop` is the primary execution path.

Identity gating:
- All workflow-loop selection and work-permission checks are enforced by authenticated worker identity.
- Only tickets assigned to the authenticated worker (`whoami`) are actionable.

Worker execution model:
- Workflow-loop starts worker runs via local OpenClaw agent CLI calls (`openclaw agent`) using explicit `--agent` and per-ticket `--session-id`.
- Worker executes in isolated session and produces a final Markdown work report.
- Workflow-loop consumes worker result (announce payload and/or transcript), evaluates forced-choice policy, then performs exactly one mutation action.
- Worker sessions are per-ticket and persistent across ticket pauses/requeues (e.g., blocked -> unblocked resume) so prior ticket-specific context is preserved.
- Worker session closes/archives when the ticket is completed.
- For blocked tickets, archive worker session after 7 days of inactivity.
- No additional session-summary persistence is required; ticket comments are the source of historical context.
- Workflow-loop enforces single active worker at a time.
- While a worker is active, workflow-loop must not select/start new ticket work; it performs housekeeping only:
  - worker completion/status checks
  - retry/fallback enforcement
  - auto-reopen processing
  - no-work detection when applicable
- Decision-agent sessions use bounded rolling reuse:
  - maximum 5 tickets per decision-agent session
  - no time-based rotation limit
  - auto-rotate early when session context reaches 50% of configured context budget

### 6.2 Auto-reopen

Trigger:
- Human comment on a ticket currently in `stage:blocked` or `stage:in-review`.

Action:
- Move ticket silently to `stage:todo`.
- No automatic reopen comment.

### 6.3 Continuous timed progress comments

- Disabled.
- Remove periodic 5-minute auto progress-comment behavior and implementation.

### 6.4 In-progress auto-heal

- Auto-heal behavior is enabled.
- If in-progress state drifts beyond allowed worker limits, automation deterministically keeps the newest in-progress ticket and moves older extra tickets back to `stage:todo` for the same authenticated worker.

### 6.5 Completion/blocked/continue decision policy

- Forced-choice decision policy is required.
- Decision source is decision-agent output from worker report facts (not worker self-finalization).
- Worker report format is Markdown (human-readable), not strict JSON.
- Worker report parsing is flexible (no strict section-header schema required initially).
- Required report facts:
  - verification evidence
  - blockers with status (`open` or `resolved`)
  - uncertainties
  - confidence (`0.0` to `1.0`)
- Decision baseline:
  - `completed` requires verification evidence and resolved blockers
  - blockers and uncertainties are required decision signals
  - decision agent must choose exactly one of: `continue`, `blocked`, `completed`
- No-decision prevention:
  - there must never be a no-decision outcome
  - if decision output is missing/invalid/ambiguous, default to `blocked`
- `confidence` is required telemetry but does not directly gate decision.
- Workflow-loop applies one mutation per decision and adds a corresponding ticket comment when mutating.
- If worker report is insufficient/unparseable, workflow-loop performs exactly one in-session retry request specifying missing report elements.
- If retry output is still insufficient/unparseable, workflow-loop must invoke decision-agent evaluation and then apply one forced-choice decision with default fallback to `blocked`.
- Worker dispatch metadata must include correlation fields: `ticketId` and `dispatchRunId`.
- Workflow-loop retry prompt should include missing-items guidance only (no full prior-report echo required).
- No separate per-run decision artifact file is required; decision context is retained in workflow-loop session history.
- On failed retry fallback, workflow-loop immediately applies `blocked` when decision output is missing/invalid/ambiguous.
- If required decision signals remain missing after retry (verification, blockers status, uncertainties, confidence), workflow-loop must coerce any non-`blocked` decision to `blocked`.
- Per ticket, `continue` is hard-limited to 2 decisions.
- After 2 `continue` decisions for the same ticket, workflow-loop must only allow `blocked` or `completed`.
- If decision agent selects `continue` after the cap is reached, workflow-loop must coerce decision to `blocked`.
- `completed` must be coerced to `blocked` unless verification evidence is present and blockers are explicitly resolved.

## 7) Scope exclusions

Out of scope for this baseline:
- GitHub adapter
- Linear adapter
- Planka adapter
- Plane-only helper command `needs-my-attention`
- Legacy command `autopilot-tick` (must be removed from CLI, docs, tests, and runtime flow)

## 8) Documentation sync

When behavior changes, keep these in sync:
- `references/REQUIREMENTS.md` (authoritative)
- `README.md`
- `SKILL.md`

## 9) Notes to revisit later

Potential future re-expansion topics (not active now):
- Re-introducing multi-adapter support
- Re-introducing direct manual mutation CLI commands
- Enriching Plane attachment/link extraction if API/CLI supports it reliably
