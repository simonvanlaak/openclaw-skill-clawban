# Parallel WIP Spec

## Status

This document is a design spec only.

It does **not** describe the current implementation.
Current KWF behavior remains single-active-ticket.

This spec is intended as a future implementation reference for bounded parallel ticket execution.

## Goal

Allow KWF to work on multiple assigned tickets at the same time while preserving:

- durable lifecycle transitions
- Plane as the human-facing source of truth
- event-driven completion and human-comment reopen
- bounded operational complexity

The target is **bounded concurrency**, not unbounded parallelism.

Recommended initial target:

- `maxConcurrentWorkers = 2`

## Non-Goals

- unbounded worker fan-out
- changing worker quality settings or lowering reasoning effort
- removing Plane as the primary human interface
- redesigning human review workflows beyond what is needed for multiple concurrent WIP tickets

## Why This Exists

The current KWF implementation is structurally single-slot:

- local runtime state has one `active` ticket
- selection assumes one active `In Progress` ticket
- queue comments assume one active offset
- Rocket.Chat status assumes one active ticket
- completion handoff fills one free slot only because only one slot exists

To support multiple WIP tickets safely, KWF needs an explicit capacity model.

## Recommended Model

Use a **slot-based concurrency model**.

Core concept:

- KWF owns `N` worker slots
- each slot may hold at most one active ticket
- a ticket becomes active when assigned to a slot
- a slot becomes free when its ticket reaches a terminal state or is otherwise cleared

Example:

- `maxConcurrentWorkers = 2`
- slots: `slot-1`, `slot-2`

## Primary Invariants

These invariants should be enforced end-to-end.

1. A ticket may not occupy more than one active slot.
2. A slot may not have more than one active ticket.
3. Number of active slots may not exceed `maxConcurrentWorkers`.
4. A ticket is only considered active if there is durable local slot ownership plus Plane `In Progress` state.
5. Terminal worker outcomes free the slot exactly once.
6. Human comment reopen must not steal or overwrite another active slot.
7. Queue and status side effects must derive from active slot state, not infer their own truth independently.

## Proposed Runtime State Shape

Current `SessionMap` is singular:

- `active?: { ticketId, sessionId }`

Future shape should be slot-based:

```ts
type ActiveSlot = {
  slotId: string;
  ticketId: string;
  sessionId: string;
  acquiredAt: string;
};

type SessionMap = {
  version: 2;
  maxConcurrentWorkers?: number;
  activeSlots?: ActiveSlot[];
  sessionsByTicket: Record<string, SessionEntry>;
  queuePosition?: ...;
  noWork?: ...;
  rocketChatStatus?: ...;
};
```

Recommended rules:

- `slotId` should be stable and human-readable, e.g. `slot-1`, `slot-2`
- `activeSlots` should be persisted in deterministic order
- `sessionsByTicket[ticketId]` remains the ticket lifecycle record
- slot occupancy is the routing layer; session entry remains the lifecycle layer

## Session Entry Changes

`SessionEntry` can remain mostly ticket-scoped.

Recommended additions:

```ts
type SessionEntry = {
  ...
  assignedSlotId?: string;
  lastActiveAt?: string;
};
```

Rules:

- `assignedSlotId` exists only when ticket is reserved or in progress
- it is cleared on terminal completion or explicit requeue
- `activeRun` remains ticket/session-specific and does not need to become slot-specific

## Selection Semantics

Current behavior:

- keep one self-assigned `In Progress`
- if none exists, pick next self-assigned `Todo`

Future behavior:

1. Discover self-assigned `In Progress` tickets.
2. Adopt up to `maxConcurrentWorkers` of them into slots.
3. If occupied slots < capacity, reserve top `Todo` tickets until capacity is full.
4. Never reserve more than available free slots.
5. Do not demote extra `In Progress` tickets automatically without explicit policy.

Important change:

Current code requeues extra `In Progress` tickets. That behavior is invalid once concurrency is intentional.

Recommended policy:

- If `In Progress` tickets exceed capacity, mark system state as drift and stop automatic reservation.
- Do not silently move user-visible work backward.

## Ticket Lifecycle Under Parallelism

Ticket lifecycle itself does not need new states.

Current states remain valid:

- `todo`
- `reserved`
- `in_progress`
- `blocked`
- `in_review`
- `completed`

What changes is slot ownership:

- `reserved` or `in_progress` tickets must be attached to one slot
- `blocked`/`in_review`/`completed` tickets must not occupy a slot

## Worker Dispatch Model

Worker dispatch should remain ticket-bound.

No shared worker sessions across tickets.

Each active ticket continues to own:

- one ticket session id
- one worker run at a time
- one durable mutation log

Parallelism is therefore achieved by having multiple active ticket sessions concurrently, not by multiplexing multiple tickets through one worker session.

## Completion Semantics

When a worker completes:

1. apply durable worker-result mutation to Plane
2. clear ticket slot ownership
3. mark ticket lifecycle terminal (`completed` / `blocked`)
4. immediately try to fill one free slot from backlog

This generalizes the current single-slot handoff:

- completion frees one slot
- selection fills one free slot

If multiple slots free in one pass, selection may fill multiple free slots up to capacity.

## Human Comment Reopen Semantics

Event-driven reopen should remain primary.

When a blocked/review ticket receives a human comment:

1. move the ticket back to `todo`
2. clear any pending mutation state
3. ensure it has no active slot
4. allow normal priority-based selection to pick it later

Important:

- reopen should **not** immediately claim a slot unless policy explicitly says so
- priority order should still govern when reopened tickets are resumed

## Queue Position Semantics

Current queue comment logic assumes:

- `activeOffset = 0 | 1`

Under parallel WIP, this becomes:

- `activeOffset = activeSlots.length`

But wording must also change.

Current wording:

- “There are X tickets with higher priority that I need to complete ... before I start this ticket.”

Parallel-aware wording should become something like:

- “There are X higher-priority tickets ahead of this one, with Y currently in progress.”

Alternative recommendation:

- temporarily disable queue-position comments during initial parallel rollout
- reintroduce them only after semantics are redesigned and tested

This is the safer rollout choice.

## Rocket.Chat Status Semantics

Current status is singular:

- `working on JULES-296`

Parallel status options:

1. Summary mode
- `working on 2 tickets`

2. Mixed mode
- `working on JULES-296, JULES-295`

3. Prioritized mode
- `working on JULES-296 (+1 more)`

Recommendation:

- use prioritized mode

It keeps status readable while still exposing the lead ticket.

## No-Work Semantics

Current no-work means:

- no active ticket
- no eligible backlog ticket

Future no-work means:

- `activeSlots.length === 0`
- and no eligible backlog ticket

If one slot is active and another is free but no backlog exists, system is **not** idle.

## Failure Handling Changes

Parallelism increases failure surface.

New required checks:

- duplicate reservation into two slots
- same ticket adopted twice after stale Plane reads
- one slot completes while another is still running
- one slot blocked while another slot continues normally
- human reopen races with another slot filling from backlog
- queue/status housekeeping must never mutate slot ownership

## Migration Strategy

Recommended rollout in phases.

### Phase 1: Data model migration

- add `version: 2`
- add `activeSlots`
- keep legacy `active` as derived compatibility field temporarily
- migrate existing `active` into `activeSlots[0]`

### Phase 2: Read-path compatibility

- implement helpers that read from `activeSlots`
- keep old single-active helpers only as wrappers during migration

### Phase 3: Selection/controller changes

- fill free slots up to capacity
- stop requeueing extra `In Progress` tickets automatically

### Phase 4: Side-effect consumers

- update Rocket.Chat status
- disable or redesign queue comments

### Phase 5: Remove compatibility layer

- remove legacy `active`
- update tests to slot-native expectations

## Required New Helpers

Recommended helper layer in `workflow_state.ts` or adjacent module:

```ts
currentActiveSlots(map): ActiveSlot[]
activeTicketIds(map): string[]
hasFreeSlot(map, maxConcurrentWorkers): boolean
freeSlotIds(map, maxConcurrentWorkers): string[]
assignTicketToSlot(map, slotId, ticketId, sessionId, now): void
clearSlotForTicket(map, ticketId): void
clearSlot(slotId): void
ticketAssignedSlot(map, ticketId): string | null
```

All lifecycle and controller code should use these helpers instead of mutating slot data inline.

## Required Test Matrix

Minimum new tests:

- starts 2 backlog tickets when capacity is 2 and no active work exists
- starts only 1 new ticket when 1 slot is already occupied
- does not exceed capacity when backlog is large
- completion of one slot immediately fills exactly one free slot
- blocked ticket frees one slot while another slot stays active
- human comment reopen returns ticket to `todo` without claiming a slot
- queue/status housekeeping does not mutate active slot ownership
- stale Plane `In Progress` drift does not create duplicate slot ownership

## Recommended Initial Scope

If this is implemented later, keep initial scope narrow:

- `maxConcurrentWorkers` config only
- initial supported values: `1` and `2`
- queue comments disabled when `maxConcurrentWorkers > 1`
- Rocket.Chat status switches to summary mode when `>1`

This keeps the first rollout smaller and lowers failure risk.

## Risks

Main risks:

- more partial-truth states if slot ownership is not made durable
- more Plane/API traffic
- more human review backlog
- more difficult debugging when multiple tickets are progressing simultaneously
- side-effect consumers becoming misleading if not redesigned

## Recommendation

If parallel WIP is pursued later, the best first implementation is:

- bounded slot model
- `maxConcurrentWorkers = 2`
- queue comments disabled for multi-slot mode
- summary Rocket.Chat status
- event-driven completion and reopen retained

Do not attempt unbounded concurrency.

Do not attempt to preserve the current single-active side-effect model while allowing multiple WIPs.

That would produce misleading Plane/Rocket.Chat truth and increase wedge risk.
