# T3 Code Authoritative Agent Board Master Plan

The roadmap for the fork, sliced. `PROJECT.md` says what the product is for;
this file says which parts of it exist and what proves they do.

Read a slice as a branch of related work. The direction lives in the matching
slice plan under `docs/agents/slices/`; the runnable scope and durable proof
live in the task records under `docs/agents/tasks/`.

## Slice status

| #   | Slice                               | Status | Where it lives                                        |
| --- | ----------------------------------- | ------ | ----------------------------------------------------- |
| 1   | Durable planning stack and contract | `done` | `packages/contracts/src/agentBoard.ts`, the docs stack |
| 2   | Board file service                  | `done` | `apps/server/src/agentBoard/AgentBoardFileSystem.ts`   |
| 3   | Planning surface                    | `done` | `apps/web/src/routes/_chat.planning.*.tsx`             |
| 4   | Task records and clarification      | `done` | `docs/agents/tasks/`, the card dialog                  |
| 5   | Board runner                        | `done` | `apps/server/src/agentBoard/AgentBoardRunner.ts`       |
| 6   | Board views                         | `done` | `apps/web/src/components/agentBoard/`                  |

All six ship. Everything still open is in `PROJECT.md` → What is not built and
Open decisions, not in a slice of its own.

## Slice 1: Durable planning stack and board contract

Status: `done`

Purpose: the project-local file structure and the typed board contract every
later slice builds on.

Proof, as recorded before the upgrade (fork commit `fb6244ca`):

- `WORKFLOW.md`, `PROJECT.md`, `CONTEXT.md`, slice plans, task records, and
  `.t3/agent-board.json` all exist and are read in that order.
- `packages/contracts` exports `AgentBoardFile`, and a title-only `Ready` card
  fails to decode.
- Focused contract tests, format, lint, and typecheck passed.

## Slice 2: Board file service

Status: `done`

Purpose: server-side load, save, and claim for `.t3/agent-board.json`, scoped to
one project root.

Proof, as recorded before the upgrade (fork commit `fb6244ca`):

- The server loads, validates, seeds, and updates a project's board without
  touching any other folder.
- Board load/save RPC contracts are exported and reachable from the client.
- Focused service tests cover create, missing file, save, and invalid `Ready`
  card paths.

Since carried further by slice 5: atomic writes, `realPath` containment, a
single mutation permit, optimistic `expectedUpdatedAt` saves, and the
operator-owned `runner` block.

## Slice 3: Planning surface

Status: `done`

Purpose: a place to see and edit the board.

Proof, as recorded before the upgrade (fork commit `fb6244ca`): a user can view
cards by state, create cards, edit planning fields, and move eligible cards to
`Ready`, persisted through the board RPCs.

Since moved from a right-side panel to the dedicated route
`/planning/$environmentId/$projectId` (web and desktop only), with the `Runner`
switch and `Break` in its header.

## Slice 4: Task records and clarification

Status: `done`

Purpose: connect cards to durable task records, and give rough work a way to
become eligible.

Proof, as recorded before the upgrade (fork commit `fb6244ca`): intent brief
fields are editable per card and save back to the board, and a card can be
linked to a record under `docs/agents/tasks/` before it moves to `Ready`.

The guided clarification interview in the UI was cut. Cards are clarified in
chat today; see `PROJECT.md` → What is not built.

## Slice 5: Board runner

Status: `done`

Purpose: claim `Ready` cards, run them in isolated worktrees, repair routine
failures, hand finished work to a fresh review thread, and write every state
change back to the board.

What shipped:

- `WorkflowFile.ts` reads `WORKFLOW.md` front matter every tick, with a
  per-project last-known-good fallback, so a bad edit never stops a card.
- `boardScheduler.ts` holds the pure parts: `selectClaimableCards`,
  `retryDelayMs`, `transition`, `patchCard`, and `RUNNER_OWNED_STATES`.
- `AgentBoardRunner.ts` is the tick: adopt, settle, retry, claim, launch,
  review. One global 1 s sweep gated per project by `polling.intervalMs`.
- Turn completion comes from `thread.session-set` events, which only nudge a
  tick; the tick is the single path that settles a turn.
- `Needs Decision` carries the question, and answering it appends
  `"<question> → <answer>"` to the brief's constraints and returns the card to
  `Ready`.

Proof:

- Board-scoped suites: **276 tests across 10 files**, all passing, via
  `vp test run` over the contracts, shared, server `agentBoard/`,
  client-runtime, and web board tests.
- `vp run --filter @t3tools/contracts --filter @t3tools/shared
  --filter @t3tools/client-runtime --filter t3 --filter @t3tools/web typecheck`
  — **five packages, 0 errors**.
- `vp lint packages/contracts/src/agentBoard.ts
  packages/contracts/src/agentBoardWorkflow.ts
  packages/shared/src/agentBoardPrompts.ts apps/server/src/agentBoard
  apps/web/src/components/agentBoard` — **clean**.
- Task record: `docs/agents/tasks/TASK-20260830-agent-board-runner.md`.

## Slice 6: Board views

Status: `done`

Purpose: more than one view over the same cards, without a second planning
system.

What shipped: Kanban (the primary control view, with drag between columns),
the Planning table (every card, including the ones Kanban has no column for),
and the dependency tree generated from `dependencies` — plus the card dialog,
the `Runner` switch with its status readout, and `Break`.

Proof: covered by the same verification pass as slice 5. The web half of it is
`agentBoardModel.test.ts`, `agentBoardDecision.test.ts`, and
`planningFeaturesState.test.ts`; the view components stay dumb over those pure
functions.

## Note on numbering

The pre-upgrade master plan (fork commit `fb6244ca`) listed seven slices, with
review and repair as slice 6 and expanded views as slice 7. Review and repair
shipped as one piece with the runner, so they are folded into slice 5 here and
views moved up to 6. Slices 1–4 keep their original numbers and their original
recorded proof.
