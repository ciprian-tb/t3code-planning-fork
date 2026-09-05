# TASK-20260830-agent-board-runner

Status: `done`
Agent eligible: no
Slice: `docs/agents/slices/authoritative-agent-board.md`

## Owner Intent

Turn the agent board from a surface a human drives into one that drives itself.
A card moved to `Ready` on an enabled project should be claimed by the server,
implemented in its own git worktree, repaired when it fails for routine reasons,
reviewed by a fresh agent with no implementation context, and left in `Review`
for a human — without anyone watching a turn go by.

## Target Status

`Tested`

## Scope Guard

Not in this task:

- Lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`).
- Merging or otherwise integrating a card's branch back into the base branch.
  The hand-off is the `Review` state and a human.
- Workspace cleanup.
- External trackers.
- Mobile Planning UI.
- A guided clarification interview in the UI.
- Cross-project scheduling or cost accounting.

No new persistence layer: `.t3/agent-board.json` stays the only durable runner
state. No changes to provider-native Plan mode, and no edits to `ChatView.tsx`.

## Acceptance Criteria

- `WORKFLOW.md` front matter is parsed, validated, and re-read every tick, with
  a per-project last-known-good fallback and the error surfaced in the UI.
- The runner is off by default and enabled per project through `runner.enabled`,
  which only the server writes.
- Only `Ready` cards with an intent brief and all dependencies `Done` are
  claimed, in `priority` then `createdAt` then id order, within the
  `agent.max_concurrent_agents` budget and the cards' parallelism plans.
- A claimed card gets `.t3/workspaces/<key>` as a git worktree on
  `agent-board/<key>`, and an implementation thread whose id is recorded only
  after the turn is accepted.
- Outcomes are read from the fenced `agent-board-result` block and nothing else.
  A missing block is treated as `continue` until `agent.max_turns` is spent.
- Routine failures stay inside the loop with exponential backoff; only an
  explicit `needs-decision`, an exhausted budget, a worker waiting on approval
  or input, or a missing project model reaches `Needs Decision`.
- Review always runs in a fresh thread on the same worktree.
- `Running`, `Diagnosing`, and `Reviewing` are runner-owned: the claim RPC
  refuses them, and refuses any claim while the runner is enabled.
- A card a human ran by hand (`runtime.phase: "manual"`) is never adopted,
  continued, parked, or stopped by the runner.
- A whole-board save carries `expectedUpdatedAt`; a stale one is refused rather
  than reverting the runner's transitions on other cards.
- A restart mid-run re-adopts in-flight cards from the board file.

## Verification

```bash
# board-scoped suites: 276 tests across 10 files, all passing
vp test run <the agentBoard tests in contracts, shared, server, client-runtime, web>

# five packages, 0 errors
vp run --filter @t3tools/contracts --filter @t3tools/shared \
  --filter @t3tools/client-runtime --filter t3 --filter @t3tools/web typecheck

# clean
vp lint packages/contracts/src/agentBoard.ts \
  packages/contracts/src/agentBoardWorkflow.ts \
  packages/shared/src/agentBoardPrompts.ts \
  apps/server/src/agentBoard apps/web/src/components/agentBoard
```

No repo-wide run. CI owns the full suite.

## Parallelism Plan

Safe: `false`

Reason: the task rewrites the board contracts, the server board services, and
the Planning UI together. Every other board card writes into the same files.

Allowed write scopes:

- `packages/contracts/src/agentBoard.ts`
- `packages/contracts/src/agentBoardWorkflow.ts`
- `packages/shared/src/agentBoardPrompts.ts`
- `apps/server/src/agentBoard/**`
- `apps/server/src/{ws,server,serverRuntimeStartup}.ts`
- `packages/client-runtime/src/state/projectCommands.ts`
- `apps/web/src/components/agentBoard/**`
- `apps/web/src/planningFeaturesState.ts`
- `apps/web/src/routes/_chat.planning.$environmentId.$projectId.tsx`
- `WORKFLOW.md`, `PATCH.md`, `PROJECT.md`, `CONTEXT.md`, `AGENTS.md`, `docs/`

Conflicts with:

- any card touching `packages/contracts/src/{rpc,ipc,index}.ts`
- any card touching the Planning route or the board components

## Proof Of Done

Implementation summary: the runner ships as one Effect service beside the
existing reactors. `WorkflowFile.ts` loads the contract, `boardScheduler.ts`
holds the pure selection, backoff, and transition logic, and
`AgentBoardRunner.ts` is the tick that adopts, settles, retries, claims,
launches, and reviews. One global 1 s sweep is gated per project by
`polling.intervalMs`; `thread.session-set` events only nudge a tick so a settled
turn cannot be handled twice.

Changed files: `packages/contracts/src/agentBoard.ts`,
`packages/contracts/src/agentBoardWorkflow.ts` (plus `rpc.ts`, `ipc.ts`,
`index.ts`), `packages/shared/src/agentBoardPrompts.ts`,
`apps/server/src/agentBoard/` (`AgentBoardFileSystem.ts`, `WorkflowFile.ts`,
`boardScheduler.ts`, `AgentBoardRunner.ts` and their tests),
`apps/server/src/{ws,server,serverRuntimeStartup}.ts`,
`apps/server/src/auth/RpcAuthorization.ts`,
`packages/client-runtime/src/state/projectCommands.ts`,
`apps/web/src/components/agentBoard/`, `apps/web/src/planningFeaturesState.ts`,
`apps/web/src/routes/_chat.planning.$environmentId.$projectId.tsx`, and the
docs stack (`AGENTS.md`, `WORKFLOW.md`, `PROJECT.md`, `CONTEXT.md`, `PATCH.md`,
`docs/agents/`, `docs/user/agent-board.md`, `docs/internals/`).

Verification results: the three commands above, as run for this task — **276
tests across 10 files** passing, **five package typechecks at 0 errors**, and
the **scoped lint clean**.

Review result: the merged branch is green and carries the fixes from review as
separate commits (manual-phase cards left entirely to the human; optimistic
board saves with a one-permit modify and no per-tick heartbeat rewrite; the
review leg restarted rather than the worker when a reviewer session dies;
distinct card ids no longer sharing one workspace segment; settles skipped for a
turn the session has not caught up with).

Remaining gaps: the plan's manual integrated pass over a live project (runner
off/on, restart mid-run, `Break`, an intentionally corrupted `WORKFLOW.md`) has
no recorded evidence in this repository, so it is not claimed here. The
behaviours it would have exercised are covered by
`apps/server/src/agentBoard/AgentBoardRunner.test.ts`. The product-level gaps
that were deliberately left open are listed in `PROJECT.md` → What is not built
and in `docs/agents/symphony-conformance.md` → Current Gaps.

Decisions made: outcomes are reported through the result block and never
inferred from a diff; `RUNNER_OWNED_STATES` stays in the server so the web
cannot import it; the runner owns the board while enabled, so manual `Run` is
refused rather than merged with it; `Break` stops the current project's runner,
and releasing it does not restart anything.
