# Project Design: T3 Code Planning Fork

The specification and the architectural decisions behind this fork, in one
place. `PROJECT.md` says what the product is for, `WORKFLOW.md` is the runtime
contract the runner reads, `PATCH.md` is the repair map against upstream. This
file is the design record: what was specified, what was decided, and why.

Baseline: upstream T3 Code `2daff8c2` (2026-08-30). Design executed 2026-08-30
to 2026-09-05 as two plans (`.plans/`), sixteen tasks, merged to `main` at
`4262fd74`.

## 1. Problem and north star

Let a user manage agent work at the project level instead of supervising every
coding turn. Cards on a project-local board carry intent briefs; moving a card
to `Ready` is the deliberate start signal; a server-side runner claims it, runs
it in an isolated worktree through ordinary T3 threads, repairs routine
failures, hands the result to a fresh review thread, and writes every state
change back to the board. The board is the authoritative source of local agent
work and the visible proof ledger, not a dashboard.

Model: OpenAI Symphony's daemon-runner shape, with the tracker swapped for a
local JSON file and the workpad swapped for markdown task records. See
`docs/agents/symphony-conformance.md` for the mapping and the gaps.

## 2. Scope

In scope: web and desktop. Out of scope, deliberately: mobile Planning UI,
workspace hooks, automatic merge of card branches, workspace cleanup, external
trackers, cross-project scheduling, cost accounting, a guided clarification
interview, and any change to provider-native Plan mode.

## 3. Planning stack

```text
AGENTS.md                       how agents behave in this repo
WORKFLOW.md                     runtime contract (YAML front matter)
PROJECT.md                      north star
CONTEXT.md                      domain language
docs/agents/project-master-plan.md   roadmap by slice
docs/agents/slices/*.md         direction for a branch of work
docs/agents/tasks/*.md          runnable scope and durable proof
.t3/agent-board.json            live orchestration state
```

`WORKFLOW.md` is optional: a missing file uses defaults for every key. The
other planning documents supply context rather than required runner config.

## 4. Specification

### 4.1 Board contract

`packages/contracts/src/agentBoard.ts`. Schema version 1. One file per
project at `.t3/agent-board.json`, decoded as `AgentBoardFile`.

States: `Backlog`, `Draft`, `Ready`, `Running`, `Diagnosing`, `Reviewing`,
`Review`, `Done`, `Blocked`, `Needs Decision`, `Canceled`.

- `Ready` is the only autonomous launch state. New cards never default to it.
  A `Ready` card without an intent brief fails to decode.
- `Running`, `Diagnosing`, `Reviewing` are runner-owned. The runner writes no
  other state except its hand-offs: `Done`, `Review`, `Needs Decision`,
  `Blocked`.
- Card runtime fields: `phase` (`implementing` | `repairing` | `reviewing` |
  `manual`), `attemptCount`, `turnCount`, `repairCycleCount`, `nextRetryAt`,
  `implementationRunId`, `reviewRunId`, `workspacePath`, `branchName`,
  `lastHeartbeatAt`, `lastResultSummary`, `reviewFindings`.
- Board `runner` block: `enabled` (default false), plus `maxConcurrentCards`
  and `repairCycles`, which decode and persist but are never read.
- `updatedAt` doubles as the optimistic-concurrency token for whole-board
  saves (`expectedUpdatedAt`, exact string equality).

Result protocol, parsed from the last fenced `agent-board-result` block in the
final assistant message:

```ts
AgentBoardWorkerResult  { outcome: "done"|"continue"|"needs-decision"|"blocked"; summary; question?; changedFiles? }
AgentBoardReviewResult  { outcome: "approved"|"changes-requested"|"needs-decision"; summary; findings?; question? }
AgentBoardRunnerStatus  { enabled; workflowSource: "workflow-md"|"last-known-good"|"defaults"; workflowError?; activeCardIds; lastTickAt? }
```

### 4.2 `WORKFLOW.md` front matter

`packages/contracts/src/agentBoardWorkflow.ts`, read by
`apps/server/src/agentBoard/WorkflowFile.ts`. Symphony-shaped keys, snake_case,
all optional, unknown keys dropped at any depth.

| Key                           | Default                | Range / rule                                  |
| ----------------------------- | ---------------------- | --------------------------------------------- |
| `tracker.kind`                | `t3-local`             | must equal `t3-local`                         |
| `tracker.board_file`          | `.t3/agent-board.json` | fixed                                         |
| `polling.interval_ms`         | 15000                  | 1000..600000                                  |
| `workspace.root`              | `.t3/workspaces`       | fixed                                         |
| `workspace.strategy`          | `per-card`             | fixed                                         |
| `agent.max_concurrent_agents` | 1                      | 1..8                                          |
| `agent.max_turns`             | 20                     | shared turn count checked before continuation |
| `agent.max_retry_backoff_ms`  | 300000                 | cap for failure backoff                       |
| `agent.max_repair_cycles`     | 3                      | review-repair rounds before `Needs Decision`  |
| `agent.review_agent`          | `fresh`                | `fresh` or `none`                             |
| `agent.on_success`            | `Review`               | `Review` or `Done`                            |

Missing file: defaults. Invalid file: last-known-good for that project, or
defaults if none has loaded in this server process. The cache is in memory and
does not survive a restart. The error is surfaced in the Planning header and
the tick continues. Re-read every tick, no watcher.

### 4.3 Selection (pure)

`selectClaimableCards(board, config)` in `boardScheduler.ts`:

1. Candidates are `Ready` cards whose every dependency is `Done`. An unknown
   dependency id blocks.
2. Free slots = `max_concurrent_agents` minus cards in runner-owned states.
3. Compare each candidate with running cards and cards already picked in this
   selection. If either group is nonempty, all must have
   `parallelism.safe == "true"`, with no `conflictsWith` overlap between the
   candidate and any of those cards in either direction.
4. Order: `priority` ascending, then `createdAt`, then `id`.

`retryDelayMs(attempt, cap) = min(cap, 1000 * 2 ** max(0, attempt - 1))`.

### 4.4 Per-card state machine

```
Ready --claim--> Running[implementing] --turn ok--> parse result
  done             -> review_agent=fresh ? Reviewing[reviewing] (fresh thread) : on_success
  continue / none  -> turnCount >= max_turns ? Needs Decision : continuation turn, turnCount++
  needs-decision   -> Needs Decision (currentDecisionQuestion)
  blocked          -> Blocked (currentError)
  turn error       -> existing attemptCount > max_repair_cycles ? Needs Decision
                      : backoff from existing count ; attemptCount++ ; Diagnosing[repairing]
  pending approval or user input on the thread -> Needs Decision
  dead provider session (server restarted)     -> re-launch: fresh thread, same worktree

Reviewing[reviewing] --review ok--> parse review result
  approved           -> on_success ; reviewFindings = []
  changes-requested  -> repairCycleCount + 1 > max_repair_cycles ? Needs Decision
                        : repairCycleCount++ ; Diagnosing[repairing] ; findings sent to implementation
  needs-decision     -> Needs Decision
  none / invalid     -> turnCount >= max_turns ? Needs Decision : nudge same review thread, turnCount++
  session error      -> retry budget/backoff as above ; clear reviewRunId ; Diagnosing[reviewing]
                        then start a fresh reviewer on retry

Any runner-owned card the user drags elsewhere -> interrupt turn, stop session, untrack.
Needs Decision + "Answer & re-run" -> answer appended to constraints as "<q> → <a>", card back to Ready,
                                      same worktree and branch reused; next claim increments attemptCount.
```

`turnCount` includes implementation launches, continuations, review starts,
and reviewer nudges. `max_turns` gates continuations and nudges against the
existing count; initial launches and fresh review starts are not gated by it.

### 4.5 Launch sequence

1. Resolve the project and require `defaultModelSelection`; otherwise park at
   `Needs Decision` with "Set a default model for this project", without a claim
   or an attempt-count increment.
2. `AgentBoardFileSystem.claim` moves the card to `Running` atomically and
   reserves `workspacePath`.
3. Best-effort append `.t3/workspaces/` to `.git/info/exclude` (idempotent;
   errors are logged and ignored).
4. Reuse `<projectRoot>/.t3/workspaces/<segment>` if it has a `.git`, else
   create a worktree on branch `agent-board/<segment>`. Colliding segments get
   a hash suffix.
5. `thread.create` with `runtimeMode: "full-access"`, `interactionMode:
"default"`, the project's default model, the worktree path and branch.
6. `thread.turn.start` with the implementation prompt from
   `packages/shared/src/agentBoardPrompts.ts`.
7. Record `implementationRunId`, `phase`, `turnCount` after the turn is
   accepted. A failed turn start deletes the newly created thread. Other
   launch failures enter the retry path, subject to the attempt budget.
   Between claim and recording the run id, a `Running` card can have no
   `implementationRunId`; recovery backs off and re-launches it.

Review mirrors 5 to 7 on a brand-new thread on the same worktree, storing
`reviewRunId`. The reviewer prompt states it has no implementation context and
asks for a diff stat against the branch point followed by the full diff,
acceptance criteria, focused verification, scope drift, missing tests, and
doc updates.

### 4.6 Tick

One global 1 s sweep; a project ticks when `now - lastTickMillis >=
polling.intervalMs`. Per project, in order: reload workflow and stamp the
tick; if `runner.enabled` is false stop tracked threads and return; drop cards
the user dragged out; adopt non-manual `Running` and `Reviewing` cards and settle
finished turns; fire due retries; claim what fits. Every 15 s the project list
is re-read. All of it runs under one `Semaphore` permit.

Turn completion: `thread.session-set` events with no active turn and a settled
status only nudge a tick. The tick is the single path that settles a turn.

### 4.7 RPC and UI

Five methods: `projects.loadAgentBoard` and `projects.getAgentBoardRunnerStatus`
(read scope); `projects.saveAgentBoard`, `projects.claimAgentBoardCard`,
`projects.setAgentBoardRunnerEnabled` (operate scope).

Planning route `/planning/$environmentId/$projectId` with Kanban (primary
control surface, drag between columns), Planning table (every card, including
those Kanban has no column for), dependency tree generated from
`dependencies`, a card dialog, a `Runner` switch with a status line
(`workflow: WORKFLOW.md | defaults | invalid (last-known-good)`, `active: n`,
`last tick`), and `Break`.

`Break` sets `runner.enabled = false` for the current project, hides the
Planning surface at render time (a direct URL redirects to chat), and does not
restart the runner when released.

## 5. Architectural decisions

Each entry: the decision, why, and what it costs if wrong. Full trail with
dates in `.superpowers/sdd/*/progress.md` (local, untracked).

### Repository and upgrade strategy

**D1. Ancestry bridge instead of rebase or force push.** The fork and upstream
share no git ancestor. An `ours` merge of the old fork tip into the upstream
baseline keeps the tree byte-for-byte upstream while making both histories
ancestors, so the public cutover is a fast-forward. Port by capability, never
replay the old snapshot commit.

**D2. Attachment points stay small and are listed in `PATCH.md`.** Any task
that changes one updates the table in the same commit. A future repair agent
reads one file to know where the patch attaches.

**D3. Two plans, one integration branch, parallel waves.** Sixteen tasks
executed by isolated subagents, one worktree each, merged by a controller into
`upgrade/latest-t3-planning`. Parallelism capped at four per wave by the
dependency graph, not the requested ten, because extra agents idle or collide
on `ws.ts`, `rpc.ts`, and `projectCommands.ts`.

### Durable state

**D4. The board file is the only durable runner state.** No SQLite table, no
sidecar. The in-memory tracked map is expendable; a restart re-adopts
in-flight cards from the board. Cost: every transition is a file write.

**D5. `runner.enabled` is operator-owned.** `save` drops the client's `runner`
block and keeps the one on disk; `setRunnerEnabled` is the only writer. A stale
tab saving a card edit cannot switch the runner off.

**D6. Whole-board saves carry `expectedUpdatedAt`, checked by exact string
equality.** Reversed a reviewer's "keep deferred": four independent finders
traced the same lost update, where editing card A from a stale snapshot writes
card B's runner transition back. The refusal message begins `Agent board
changed`; the web matches that prefix (`isBoardConflictError`) to reload and
re-ask. The prefix is a cross-layer contract. Change it and the predicate in
the same commit.

**D7. `modify` is the server-internal read-modify-write** and holds the
mutation permit across both halves. `load` plus `save` are two critical
sections and a client write can slot between them. A serialisation test for
this was written, proven non-discriminating against Effect's semaphore
scheduling, and dropped rather than shipped as false confidence.

**D8. The per-tick heartbeat rewrite was deleted.** `lastHeartbeatAt` has no
readers. The pass rewrote the whole board every polling interval, bumping
`updatedAt` and racing every panel save. Per-transition stamps stay;
`status.lastTickAt` is the liveness signal. Cost: no in-file liveness.

**D9. `.t3/agent-board.json` stays JSON.** SQLite with JSON export remains an
open decision in `PROJECT.md`; nothing built so far needs it.

### Ownership and authority

**D10. `RUNNER_OWNED_STATES` lives in the server, not in contracts.** Contracts
are importable by the web app; this set is a server-side authorisation rule.
Keeping it out of contracts prevents a client-side copy that drifts from what
the RPC enforces.

**D11. Two-layer claim, only the outer one is safety.**
`AgentBoardFileSystem.claim` accepts `Ready` or `Diagnosing` (the runner's
re-launch path needs the same reservation). The `claimAgentBoardCard` handler
refuses runner-owned states and refuses every claim while the runner is
enabled, because the client's snapshot is up to a poll interval stale.
`runCardError` on the client is the courtesy layer, not the rule.

**D12. Manual `Run` writes `runtime.phase: "manual"`.** A human-run card is
human-owned: the runner never adopts, continues, parks, or stops it, and the
human moves it on. A failed manual launch records no run id, because the
thread is a client-side draft until the user presses Send. Closes the "draft
thread with no server thread parks at Needs Decision" hole without
re-implementing the runner's launch on the client.

**D13. `saveCard` only patches a card still in a runner-owned state or
`Ready`.** A card the user dragged elsewhere is left exactly as they left it.
`Ready` is in the set because two pre-claim callers (missing model, pre-launch
failure) legitimately transition a still-Ready card.

**D14. Releasing `Break` does not restart the runner.** Turning a surface back
on must not silently resume agents.

**D15. Planning is gated at render, not by redirect.** The `Break` flag is
read synchronously so the board panel never mounts, and so never creates a
board file, in a project whose Planning is broken.

### Scheduling and turn handling

**D16. One global sweep, per-project gating.** One timer, one fiber, one
semaphore. Each project's `WORKFLOW.md` sets its own cadence without owning a
fiber. Upgrade path if it stops holding: split the lock per root.

**D17. Events nudge, they never settle.** `onEvent` only runs a tick for the
thread's root. Turn completion has one code path, the adopt-and-settle loop,
so a racing event and poll cannot both settle the same turn. The event is a
latency optimisation over the poll interval.

**D18. "No `implementationRunId`, re-launch" is required, not deferred.**
Reversed an earlier deferral after review proved it turned every transient
projection, claim, or worktree failure into a false terminal park one tick
later.

**D19. A dead provider session is not a failed turn.** Found by the integrated
pass: after a server restart, the runner kept sending continuations to a
conversation the provider had dropped and parked the card in twelve seconds.
The retry now drops the recorded run id so the card takes the re-launch
branch and gets a fresh thread on the same worktree. The orphaned-session
sentinel moved to `packages/contracts` so the writer in startup reconciliation
and the reader in the runner share one definition.

**D20. Settle suppression is time-bounded, not marker-bounded.** The briefed
"skip while a turn is pending" suppressed legitimate settles because the
normal completion path has no intervening tick. Shipped instead: skip while
the session's `updatedAt` predates the pending turn, for at most four polling
intervals after dispatch.

**D21. `attemptCount` bumps twice per re-launch cycle** (claim plus
retry-later), halving the effective `max_repair_cycles`. Accepted as a
recorded spec deviation. Later shown to be load-bearing by D19's failure mode.
Still accepted, since the restart fix removed the failure that exposed it.
Revisit if operators report early parking.

**D22. A blank optional string in a result block reads as absent.** Found by
the integrated pass: a reviewer emitting `"question": ""` had its block
rejected, costing four turns on a trivial card.

### Worktrees and branches

**D23. Per-card worktree at `.t3/workspaces/<segment>` on
`agent-board/<segment>`.** Reused across retries, repair, review, and
answer-and-re-run, so no context is lost. `.t3/workspaces/` is appended to
`.git/info/exclude`, never `.gitignore`, so the patch leaves no tracked trace.

**D24. The hand-rolled slugifier stays.** Upstream's `sanitizeBranchFragment`
lowercases and preserves `/`, which would break existing workspace paths and
branch names. Colliding segments get a hash suffix, because the real failure
was silent worktree sharing through the `.git` reuse probe.

**D25. No automatic merge.** The default hand-off is the `Review` state and a
human. Integration strategy (merge, patch, or a review thread) is an open
decision.

### Prompts and protocol

**D26. Prompt builders and parsers live in `packages/shared`** so the server
runner and the web manual-run path share them.

**D27. Outcomes come from a machine-readable block, never from diffs.** The
last fenced `agent-board-result` block wins. A worker parse failure is treated
as `continue`; a reviewer parse failure nudges the same review thread to
produce a valid result, subject to the turn budget. The cost is protocol-level
Symphony non-conformance: outcomes arrive as assistant text, not a structured
worker reply.

**D28. Continuation prompts never resend the full brief.** Card id, reason,
"continue in this workspace", protocol footer.

**D29. A fresh review thread per review**, never the implementation thread,
so the reviewer begins with no implementation context.

### Schema and spec fidelity

**D30. Spec-defined but unread fields are kept**: `runner.maxConcurrentCards`,
`runner.repairCycles`, `defaultView`, `graphLinks`, `graphPosition`. The user
asked for the full spec; deleting spec fields is the user's call. Recorded in
`docs/agents/symphony-conformance.md` so nobody plans against them.

**D31. `WORKFLOW.md` values win over board `runner.*` fallbacks**, and in
practice the fallbacks are never consulted.

**D32. Unknown front-matter keys are dropped, not rejected**, so Symphony's
`hooks:` and `codex:` blocks parse without error.

### Verification discipline

**D33. Mutation testing over coverage.** Every non-trivial pure function ships
one focused Vitest file, and each fix wave proved its tests by killing named
mutants. Tests that a mutant survives are dropped, not shipped.

**D34. No repo-wide checks locally.** CI owns the full suite. Local
verification is the ten board-scoped test files, five focused typechecks, and
a scoped lint.

**D35. An integrated app pass is part of done.** Nine scenarios against a
scratch project on a dev server, recorded in
`docs/agents/tasks/TASK-20260830-agent-board-runner.md`. It found D19 and D22,
which unit tests had missed.

## 6. Known gaps and deferred items

- `Break` stops only the current project's runner; the flag is global to the
  browser, `runner.enabled` is per project.
- Manual `Run` stays visible while the runner is on and errors only on click.
- Canceled cards vanish from Kanban (no column) and can only be recovered from
  the Planning table. They keep a stale `runtime.phase`.
- Thread-title regeneration usually replaces the seeded "Implement …" and
  "Review …" titles, so board threads are not reliably identifiable by prefix.
- A multi-line YAML parse error wraps the Planning header badly.
- No lifecycle hooks, no workspace cleanup.

## 7. Open decisions

Carried from `PROJECT.md`: JSON versus SQLite for the board; how card branches
integrate; whether task records carry YAML front matter for two-way sync;
whether `Break` should stop every project's runner.

## 8. Where things live

| Concern                      | Path                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| Board and result contracts   | `packages/contracts/src/agentBoard.ts`                             |
| Workflow front-matter schema | `packages/contracts/src/agentBoardWorkflow.ts`                     |
| Prompts and parsers          | `packages/shared/src/agentBoardPrompts.ts`                         |
| Board file service           | `apps/server/src/agentBoard/AgentBoardFileSystem.ts`               |
| Workflow loader              | `apps/server/src/agentBoard/WorkflowFile.ts`                       |
| Pure scheduling              | `apps/server/src/agentBoard/boardScheduler.ts`                     |
| Runner                       | `apps/server/src/agentBoard/AgentBoardRunner.ts`                   |
| Web views and model          | `apps/web/src/components/agentBoard/`                              |
| Planning route               | `apps/web/src/routes/_chat.planning.$environmentId.$projectId.tsx` |
| Break state                  | `apps/web/src/planningFeaturesState.ts`                            |
| Ownership model, in depth    | `docs/internals/agent-board-runner.md`                             |
| User guide                   | `docs/user/agent-board.md`                                         |
| Symphony mapping             | `docs/agents/symphony-conformance.md`                              |
| Roadmap by slice             | `docs/agents/project-master-plan.md`                               |
| Repair map                   | `PATCH.md`                                                         |
| Original plans               | `.plans/2026-08-30-*.md`                                           |
