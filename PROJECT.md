# T3 Code Authoritative Agent Board

What this fork is trying to become. `WORKFLOW.md` says how agents work here;
this file says what the product is for.

## North star

Let a user manage agent work at the project level instead of supervising every
coding turn. Break a large project into durable plans, task records, and board
cards; move selected work to `Ready`; let T3 Code run a self-testing,
self-reviewing agent loop inside isolated worktrees.

The board is not a dashboard. It is the authoritative source of local agent work
for the active project, and the visible proof ledger for what was actually done.

## Target user

Works at a product and planning level. Willing to invest up front in intent,
scope, and sequencing; not willing to inspect every low-level failure or shepherd
each agent through implementation, tests, review, and integration.

## Core workflow

1. Open a project and its Planning surface.
2. Capture a rough card. New cards land in `Backlog` or `Draft`.
3. Clarify until the card has an intent brief: outcome, acceptance criteria,
   constraints, non-goals, dependencies.
4. Write or link the task record under `docs/agents/tasks/`.
5. Move the card to `Ready` — the deliberate start-work signal.
6. Turn the runner on. It claims the card, creates an isolated worktree, and
   launches an implementation thread.
7. Routine failures are diagnosed and repaired inside the loop.
8. A fresh review thread with no implementation context evaluates the work.
9. The card lands in `Review` (default) or `Done`, or stops at `Needs Decision`
   with a specific question.
10. The runner moves to the next eligible `Ready` card.

## Planning stack

```text
AGENTS.md
WORKFLOW.md
PROJECT.md
CONTEXT.md
docs/agents/project-master-plan.md
docs/agents/slices/*.md
docs/agents/tasks/*.md
.t3/agent-board.json
```

`WORKFLOW.md` is the operating contract, `PROJECT.md` the north star,
`CONTEXT.md` the domain language, the master plan the roadmap, slice plans the
direction for a branch of related work, task records the runnable scope and
durable proof, and the board file the live orchestration state.

## What is built

- Typed board contracts, project-local board file with atomic writes and path
  containment, and five RPC methods behind read/operate scopes.
- A Planning route (web and desktop) with Kanban, Planning table, and dependency
  tree views over the same cards, card detail editing, and a `Break` kill
  switch.
- A server-side board runner driven by `WORKFLOW.md`: selection with
  dependencies and parallelism rules, per-card worktrees, implementation and
  fresh-review threads, exponential backoff, repair cycles, restart recovery,
  and `Needs Decision` hand-offs with an "answer and re-run" path.
- A machine-readable result protocol (`agent-board-result`) so outcomes are
  reported, never guessed from diffs.

## What is not built

- Workspace hooks (Symphony's `after_create` / `before_run` / `after_run` /
  `before_remove`).
- Automatic merge or integration of a card's branch back into the base branch.
  The default hand-off is the `Review` state and a human.
- Workspace cleanup.
- External trackers (Linear, GitHub Issues).
- A guided clarification interview in the UI. Cards are clarified in chat today.
- Mobile Planning UI.
- Cross-project scheduling and cost accounting.

## Non-goals

- Replacing external trackers for teams that already have one.
- A cloud orchestration service.
- Auto-running title-only cards. A `Ready` card without an intent brief does not
  decode.
- Running every `Ready` card in parallel by default.
- Making the dependency tree the primary control surface. Kanban is.
- Requiring the full planning stack before simple cards work. Only
  `WORKFLOW.md` is required, and even that has defaults.

## Open decisions

- Whether the board file should stay JSON or move to SQLite with JSON export.
- How card branches should be integrated: merge, patch, or a review thread.
- Whether task records should carry YAML front matter so the board can sync
  planning fields both ways.
- Whether `Break` should stop every project's runner rather than only the one
  whose Planning route is open.
