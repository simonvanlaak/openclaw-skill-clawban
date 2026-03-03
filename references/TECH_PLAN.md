# Kanban Workflow - Technical Plan (Plane-only)

Status: active implementation plan
Last updated: 2026-03-02
Source of truth: `references/REQUIREMENTS.md`

## 1) Objective

Implement a clean, navigable architecture for a Plane-only workflow system with:
- one local orchestrator command: `workflow-loop`
- one active worker session at a time
- one decision-agent evaluation per worker completion
- forced-choice outcome (`continue | blocked | completed`) with `blocked` fallback when decision output is invalid/ambiguous

## 2) Runtime architecture

### 2.1 Roles

- `workflow-loop` (local CLI/script, non-agent)
  - authoritative orchestrator
  - single mutation authority
  - no LLM tokens consumed by loop itself

- Worker agent session (OpenClaw subagent)
  - performs implementation work
  - outputs Markdown work report
  - session is per-ticket and persistent across requeues

- Decision agent session (OpenClaw subagent)
  - classifies worker result into exactly one decision
  - bounded rolling session reuse: max 5 tickets, rotate at 50% context budget

### 2.2 High-level flow

1. `workflow-loop` loads state + Plane snapshot.
2. If active worker exists:
   - do housekeeping only (status checks, retry enforcement, auto-reopen handling).
3. If no active worker:
   - select next actionable ticket (strict assignee=`whoami`, merged all-project backlog ordering).
   - start or resume per-ticket worker session.
4. On worker completion:
   - parse report sufficiency.
   - if insufficient -> one retry prompt with missing items only.
   - if still insufficient -> invoke decision agent; invalid/ambiguous decision defaults to `blocked`.
5. Apply exactly one mutation + comment.
6. Update session map and loop state.

## 3) Code architecture (navigable module boundaries)

```text
src/
  cli/
    run.ts                      # command routing
    parse.ts                    # flag parsing (minimal)

  application/
    workflow_loop.ts            # orchestration entrypoint for command
    setup.ts                    # setup command use-case
    show.ts                     # show use-case
    create.ts                   # create use-case

  core/
    types.ts                    # domain and contracts
    ordering.ts                 # priority/title deterministic ordering
    report_parser.ts            # flexible markdown -> normalized report facts
    decision_contract.ts        # decision-agent IO schema and validation
    policies/
      continue_cap.ts           # max 2 continue policy
      retry_policy.ts           # one retry max policy
      fallback_policy.ts        # invalid decision -> blocked

  loop/
    state_store.ts              # .tmp/kwf-session-map.json access
    worker_sessions.ts          # per-ticket worker session lifecycle
    decision_sessions.ts        # rolling decision-agent session policy
    auto_reopen_runner.ts       # silent reopen processing
    mutation_executor.ts        # single mutation authority
    selection.ts                # next actionable ticket resolver

  plane/
    adapter.ts                  # Plane read/write API boundary
    mapping.ts                  # canonical<->plane stage mapping
    identity.ts                 # whoami resolution helpers
```

Boundary rules:
- Only `plane/adapter.ts` talks to Plane CLI/API.
- Only `loop/mutation_executor.ts` performs ticket mutations.
- `core/*` is pure logic (test-first, no IO).
- `application/workflow_loop.ts` coordinates modules; it contains no domain rules.

## 4) State model

Primary state file: `.tmp/kwf-session-map.json`

Required records:
- `activeWorker`
  - ticketId
  - workerSessionId
  - startedAt
  - lastActivityAt
- `ticketSessions`
  - ticketId -> workerSessionId
  - continueCount
  - status (`active|blocked|completed|archived`)
  - lastActivityAt
- `decisionSession`
  - sessionId
  - ticketsUsedCount
  - contextUsageRatio
- `dispatchRuns`
  - dispatchRunId
  - ticketId
  - timestamps
  - finalDecision

No separate decision artifact file is created.

## 5) Selection and ordering logic

Actionable backlog candidates must satisfy:
- stage `stage:todo`
- assignee exactly equals authenticated `whoami`

Ordering across all monitored projects:
1. higher priority first
2. tie-break by ticket title alphabetical
3. deterministic final tie-break by ticket id (implementation detail)

If active worker exists, no new selection is performed.

## 6) Worker report and decision path

### 6.1 Worker report requirements (Markdown, flexible parsing)

Required facts to extract:
- verification evidence
- blockers with status (`open|resolved`)
- uncertainties
- confidence (`0.0..1.0`)

### 6.2 Retry policy

- If report insufficient/unparseable:
  - one retry only
  - retry prompt includes missing items only
- If still insufficient:
  - call decision agent once
  - if decision invalid/ambiguous -> force `blocked`

### 6.3 Decision policy

- Decision agent must return exactly one of:
  - `continue`
  - `blocked`
  - `completed`

Enforcements by loop:
- `completed` accepted only when verification evidence exists and blockers resolved.
- per-ticket `continue` cap is 2.
- if decision is `continue` after cap -> coerce to `blocked`.
- invalid/missing/ambiguous decision -> `blocked`.

## 7) Mutation semantics

Only loop mutates Plane tickets.

- `continue`
  - post progress comment
  - no stage change
- `blocked`
  - post block/insufficiency comment (freeform)
  - move stage to `stage:blocked`
- `completed`
  - post completion comment
  - move stage to `stage:in-review`

## 8) Session lifecycle policies

Worker sessions:
- one persistent session per ticket
- reused after unblock/resume
- archived on completed
- archived after 7 days inactivity for blocked tickets

Decision-agent sessions:
- rolling session
- max 5 tickets per session
- no time-based limit
- early rotate when context usage >= 50%

## 9) Command surface

Supported commands:
- `kanban-workflow setup --adapter plane ...`
- `kanban-workflow show --id <ticket-id>`
- `kanban-workflow create --project-id <uuid> --title "..." [--body "..."]`
- `kanban-workflow workflow-loop [--dry-run]`

Removed commands/features:
- `next`
- manual mutation commands (`start|update|ask|complete`)
- legacy aliases (`continue|blocked|completed` as direct user commands)
- non-Plane adapters

## 10) Migration phases

Phase 1: command + naming alignment
- rename command path to `workflow-loop`
- remove deprecated command handlers

Phase 2: plane-only boundary
- remove non-Plane adapter wiring from config + CLI + exports

Phase 3: orchestration extraction
- move loop orchestration out of CLI into `application/workflow_loop.ts`
- introduce `loop/*` modules

Phase 4: decision pipeline
- add report parser + decision contract + retry/continue-cap/fallback policies
- integrate decision-agent session management

Phase 5: session lifecycle hardening
- per-ticket worker session reuse + archival rules
- decision session rotation policy

Phase 6: docs/tests cleanup
- update README/SKILL to match requirements
- remove obsolete tests, add loop-focused tests

## 11) Testing strategy

Unit tests (pure logic):
- ordering across projects
- report parsing sufficiency
- continue cap coercion
- fallback policy
- session rotation thresholds

Integration tests (loop):
- active worker blocks new selection
- retry once then forced blocked
- decision invalid -> blocked
- blocked ticket resume reuses same worker session
- blocked inactivity archival at 7 days

Adapter tests (Plane):
- identity gating correctness
- create with mandatory project id + assignment failure handling
- show payload completeness with silent optional fields

## 12) Operational notes

- Preferred scheduler: local system cron running `workflow-loop`.
- Loop should remain fail-soft and idempotent per tick.
- All error messages intended for user CLI paths should stay short and direct.

## 13) OpenClaw execution boundary findings (2026-03-02)

Validated runtime behavior and docs alignment for worker/decision execution:

- `openclaw sessions` CLI is list/maintenance only (sessions + cleanup); it is not an execution entrypoint.
- `sessions_spawn` / `sessions_send` are documented as agent tools (tool-policy surface), not stable public gateway RPC method names for local script orchestration.
- `openclaw gateway call <method>` is low-level RPC and should be treated as less stable for this use case.
- `openclaw agent` is the stable documented local CLI primitive for direct agent turns with session reuse (`--agent`, `--session-id`, `--message`, `--json`).

Implementation decision:

- `workflow-loop` stays local/non-agent orchestrator.
- Worker and decision turns are executed via `openclaw agent ... --json`.
- Session continuity is enforced by explicit `--session-id` values managed in `.tmp/kwf-session-map.json`.
- Correlation metadata (`ticketId`, `dispatchRunId`) is included in the worker dispatch message envelope.
