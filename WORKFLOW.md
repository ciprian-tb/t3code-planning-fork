---
tracker:
  kind: t3-local
  board_file: .t3/agent-board.json
  active_states: [Ready, Running, Diagnosing, Reviewing]
  terminal_states: [Done, Canceled]
polling:
  interval_ms: 15000
workspace:
  root: .t3/workspaces
  strategy: per-card
agent:
  max_concurrent_agents: 1
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_repair_cycles: 3
  review_agent: fresh
  on_success: Review
---

# T3 Code Agent Board Workflow

This file is the runtime contract for the board runner and the operating policy
for every agent working a board card. The front matter above is the config the
runner reads; the body is the policy agents follow.

## Front matter contract

Parsed by `apps/server/src/agentBoard/WorkflowFile.ts` and decoded with
`AgentBoardWorkflowConfig` (`packages/contracts/src/agentBoardWorkflow.ts`).

| Key                           | Default  | Meaning                                                     |
| ----------------------------- | -------- | ----------------------------------------------------------- |
| `tracker.kind`                | —        | Must be `t3-local`. Any other value makes the file invalid. |
| `tracker.board_file`          | —        | Must be `.t3/agent-board.json`.                             |
| `polling.interval_ms`         | `15000`  | Tick interval per project. Range 1000–600000.               |
| `workspace.root`              | —        | Must be `.t3/workspaces`.                                   |
| `workspace.strategy`          | —        | Must be `per-card`.                                         |
| `agent.max_concurrent_agents` | `1`      | Cards the runner may own at once. Range 1–8.                |
| `agent.max_turns`             | `20`     | Worker turns per card before `Needs Decision`. Range 1–200. |
| `agent.max_retry_backoff_ms`  | `300000` | Cap on failure backoff. Range 1000–3600000.                 |
| `agent.max_repair_cycles`     | `3`      | Review→repair rounds before `Needs Decision`. Range 0–20.   |
| `agent.review_agent`          | `fresh`  | `fresh` spawns a review thread; `none` skips review.        |
| `agent.on_success`            | `Review` | State after an approved review: `Review` or `Done`.         |

Rules the loader actually applies:

- Every key is optional. An empty front matter block, a file with no front
  matter block at all, and a missing `WORKFLOW.md` all mean "use the defaults".
- Unknown keys are dropped, at any nesting depth. Symphony's `hooks:` and
  `codex:` blocks parse fine here and do nothing — this fork does not run
  hooks, and the runner launches whatever provider the project's default model
  selection points at rather than a fixed `codex app-server` command.
- `tracker`, `workspace.root`, and `workspace.strategy` are validated and then
  discarded. They exist to reject a file written for another tracker.
- `tracker.active_states` and `tracker.terminal_states` are informational. The
  runner uses a fixed set (see Board states).
- Invalid YAML or a value out of range keeps the last config that parsed for
  that project (`workflowSource: last-known-good`), or the defaults if none
  ever did, and reports the error in the Planning header. A bad edit never
  crashes a tick and never stops an in-flight card.
- The file is re-read every tick. That is the dynamic reload; there is no
  watcher. Last-known-good is in memory only, so a restart with a still-broken
  file falls back to the defaults.
- `WORKFLOW.md` wins over the board's own `runner.maxConcurrentCards` /
  `runner.repairCycles` fields.

## Runner enablement

The runner is off by default and is enabled per project, not globally.
`.t3/agent-board.json` → `runner.enabled: true` turns it on for that project
and survives restarts.

That flag is operator-owned. `AgentBoardFileSystem.save` deliberately drops
whatever `runner` block a client sends and keeps the one on disk, so a stale
board snapshot in a browser tab cannot switch the runner off by saving a card
edit. `setRunnerEnabled` (RPC `projects.setAgentBoardRunnerEnabled`) is the only
writer, and it nudges the runner so the change takes effect immediately instead
of on the next poll.

The Planning header carries the switch and a one-line readout: workflow source
(`WORKFLOW.md`, `defaults`, or `invalid: <error>`) and the number of active
cards.

`Break` in the same header is the kill switch. It stops the runner for the
project you are looking at, then hides the Planning surface and returns you to
chat; the flag is persisted in browser local storage, so Planning stays shut
across reloads until you release it. Releasing `Break` reopens Planning but
deliberately does **not** restart the runner — that is a separate decision made
with the `Runner` switch.

While the runner is enabled it owns the board: the manual "Run this card"
control refuses with a visible reason, and the `projects.claimAgentBoardCard`
RPC refuses any card already in `Running`, `Diagnosing`, or `Reviewing`.

## Result protocol

Every implementation and review turn must end with exactly one fenced
`agent-board-result` JSON block. It is the only thing the runner reads to
decide what happens next; it never inspects diffs or guesses.

Worker turns:

```agent-board-result
{"outcome":"done","summary":"...","changedFiles":["..."]}
```

- `done` — every acceptance criterion is met, focused verification passed, and
  the task record's proof section is updated.
- `continue` — out of turn budget but the work is on track.
- `needs-decision` — intent, scope, risk, credentials, cost, or a destructive
  action. `question` is mandatory and is what the human is asked.
- `blocked` — an external blocker you cannot resolve.

Review turns use `approved`, `changes-requested`, or `needs-decision`.
`changes-requested` requires `findings`, which are handed to the implementation
agent verbatim.

A missing or unparseable block is treated as `continue`: the runner re-prompts
the same thread until `agent.max_turns` is spent, then parks the card at
`Needs Decision`. If you emit more than one block, the last one wins.

## Source of truth

Agents and the runner treat these as the control stack, in this order:

1. `AGENTS.md`
2. `WORKFLOW.md`
3. `PROJECT.md`
4. `CONTEXT.md`
5. `docs/agents/project-master-plan.md`
6. the relevant slice plan under `docs/agents/slices/`
7. the linked task record under `docs/agents/tasks/`
8. `.t3/agent-board.json`

`WORKFLOW.md` defines how agents work. `PROJECT.md` defines what the project is
trying to become. Task records define exact runnable scope. The board file holds
live orchestration state. Only `WORKFLOW.md` is required for the runner
contract; the rest are context anchors.

## Board states

- `Backlog` — captured, not eligible for pickup.
- `Draft` — rough work that needs acceptance or clarification.
- `Ready` — eligible for autonomous pickup. The only launch state.
- `Running` — an implementation turn is in flight.
- `Diagnosing` — waiting out a failure backoff, or repairing review findings.
- `Reviewing` — a fresh review thread is evaluating the work.
- `Review` — done enough for human inspection. Default `on_success` landing.
- `Done` — proof, integration, and board/task updates complete.
- `Blocked` — an external blocker the worker reported.
- `Needs Decision` — waiting on the user; `runtime.currentDecisionQuestion`
  holds the question.
- `Canceled` — intentionally stopped.

`Running`, `Diagnosing`, and `Reviewing` are runner-owned. New cards must not
default to `Ready`; moving a card to `Ready` is the deliberate start-work
signal.

Kanban shows `Draft`, `Ready`, `Running`, `Review`, `Done`, and
`Needs Decision`. Cards parked in `Backlog`, `Diagnosing`, `Reviewing`,
`Blocked`, or `Canceled` are visible in the Planning table.

## Card eligibility

A card may enter `Ready` only when all of these hold:

- It has a title and an intent brief. The schema enforces this: a `Ready` card
  without `intentBrief` fails to decode, so a title-only card cannot be saved
  as `Ready`.
- Acceptance criteria or proof-of-done are specific enough to verify.
- Non-goals and scope guards are explicit for non-trivial work.
- Dependencies are listed, and every dependency is `Done` before the runner
  will claim it. An unknown dependency id blocks the card forever — that is a
  broken board, not a finished one.
- A parallelism plan is present when concurrent execution is wanted.
- It links to a task record, or one is created before launch.

If eligibility is missing, run the clarification flow instead of starting
implementation: interview the user one question at a time and fill owner
intent, desired outcome, acceptance criteria, constraints, non-goals,
dependencies, relevant files, proof-of-done, open decisions, and the
parallelism plan.

## Selection and parallelism

Per tick the runner picks cards with `selectClaimableCards`
(`apps/server/src/agentBoard/boardScheduler.ts`):

1. Candidates are `Ready` cards with an intent brief and all dependencies
   `Done`.
2. Free slots = `agent.max_concurrent_agents` minus the cards already in a
   runner-owned state. No slots, no launches.
3. If anything is already running, the candidate and every in-flight card must
   all have `parallelism.safe === "true"`, with no `conflictsWith` overlap in
   either direction.
4. Order: `priority` ascending (1 is highest), then `createdAt`, then card id.

Default concurrency is one card per project. Parallelism is planned metadata,
never inferred from user impatience. Document in the plan why it is safe, what
it conflicts with, and the allowed write scopes.

## Autonomous delivery loop

When a `Ready` card is claimed:

1. The card moves to `Running` and `attemptCount` increments.
2. `.git/info/exclude` gets `.t3/workspaces/` (idempotent) so card checkouts
   never show up as untracked noise in the project.
3. The card workspace `.t3/workspaces/<key>` is created as a git worktree on
   branch `agent-board/<key>`, or reused if it already has a `.git`. The key is
   the card id reduced to `[A-Za-z0-9_-]`, trimmed of dashes, capped at 80
   characters.
4. A thread `Implement <title>` is created against that worktree with the
   project's default model, `full-access` runtime mode, and the default
   interaction mode, and the first turn carries the full rendered card prompt.
5. `runtime.implementationRunId` is written back only after the turn is
   accepted, so a `Running` card always names the thread that owns it.

The card needs a default model on the project. Without one the runner parks it
at `Needs Decision` before claiming, so the retry budget is untouched.

Continuation turns reuse the same thread and send only the reason plus the
board/task delta — never the full brief again. Review mirrors the launch with a
new thread `Review <title>` on the same worktree, so the reviewer starts with no
implementation context.

Routine failures stay inside the loop: test, lint, and typecheck failures,
incomplete implementations, review findings, and repairable conflicts. Turn
errors move the card to `Diagnosing` with exponential backoff (1s doubling per
attempt, capped by `agent.max_retry_backoff_ms`).

The card leaves the loop for `Needs Decision` only on an explicit
`needs-decision` outcome, an exhausted `max_repair_cycles` or `max_turns`
budget, a worker thread waiting on an approval or user input, or a missing
project model. Answering the question from the card dialog appends
`"<question> → <answer>"` to the intent brief's constraints and moves the card
back to `Ready`, so the next prompt carries the answer.

## Reconciliation

The board file is the only durable runner state; in-memory scheduler state is
expendable.

- Every tick re-adopts cards the board says the runner owns, reading
  `implementationRunId` or `reviewRunId` depending on `runtime.phase`. A
  restart mid-run picks the card back up.
- A runner-owned card with no thread id is re-launched rather than parked, so a
  transient failure before the thread existed does not need a manual rescue.
- A card whose worker thread no longer exists goes to `Needs Decision`.
- Move a `Running` card anywhere the runner does not own and its turn is
  interrupted, its session is stopped, and the runner forgets it.
- Turn completion is detected from the engine's `thread.session-set` events,
  which only nudge a tick — the tick itself is the single code path that settles
  a turn, so an event and a poll cannot both handle the same completion.

## Workspaces

Each runnable card gets its own worktree under `.t3/workspaces/`. Agents do not
work in the main project folder. Workspaces are reused across retries for the
same card and are never deleted automatically; cleanup is a human decision once
the card is terminal and nothing still needs the checkout.

The runner records `workspacePath`, `branchName`, and run ids on the card.
`.t3/` is gitignored, so none of this reaches the project's history.

## Task records and the proof ledger

One task record per card under `docs/agents/tasks/`, from
`docs/agents/tasks/TEMPLATE.md`. That record is the persistent workpad — the
local stand-in for Symphony's single Linear workpad comment. Keep plan,
acceptance criteria, validation, notes, blockers, and final proof in that one
file; do not scatter progress across chat turns or ad hoc markdown.

Planning fields may sync between a card and its record: title, intent,
acceptance criteria, constraints, non-goals, dependencies, priority, allowed
write scopes, parallelism plan.

Runtime state belongs to `.t3/agent-board.json` only: state, workspace path,
branch, run ids, attempt/turn/repair counts, heartbeat, current error, review
findings, last result summary.

Proof belongs to the task record only: implementation summary, changed files,
verification results, review findings, proof-of-done, remaining gaps, decisions
made.

Before a card reaches `Review` or `Done`, its record must show a completed plan
checklist, completed acceptance criteria, the validation commands and their
results, a changed-files summary, the review result, and either the unresolved
gaps or an explicit statement that none remain.

## Dependency graph sync

The Planning dependency tree is a generated view over the board. Whenever you
change planning markdown, update the structured fields too: `area`, `slice`,
`dependencies`, `slicePlanPath`, `taskRecordPath`. Markdown explains why an
edge exists; the board fields are the only source of edge truth.

Dependency edges are hard execution blockers only. For anything looser use the
relationship vocabulary in `AGENTS.md` (`connects to`, `shares contract with`,
`conflicts with`, `enables`) in prose, and put real parallel-execution hazards
in the card's `parallelism.conflictsWith`.

## Patch tracking

This fork stays publishable while upstream T3 Code keeps moving. Any change to
planning behaviour updates `PATCH.md` in the same task. When an upstream update
breaks the fork, start from `PATCH.md`, then check `AGENTS.md`, this file, the
board contracts, the server board services, and the Planning route.
