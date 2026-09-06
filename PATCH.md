# T3 Code Planning Patch

Repair map for this fork. If an upstream update breaks Planning, start here.

## What the patch adds

- A project-local planning board at `.t3/agent-board.json`, with Kanban,
  Planning table, and Dependency tree views on a dedicated route.
- A server-side board runner that claims `Ready` cards, runs them in isolated
  git worktrees through ordinary T3 threads, repairs routine failures, hands
  finished work to a fresh review thread, and writes every state change back to
  the board file.
- `WORKFLOW.md` as the runtime contract for that runner.
- The supervisor-first workflow and the markdown planning stack under
  `docs/agents/`.
- A `Break` control that stops the runner and shuts the Planning surface when
  the fork misbehaves mid-session.

## Scope

Web and desktop only. Desktop wraps the web app, so it is covered for free.
Mobile is a deliberate non-goal: `apps/mobile` contains no board code and must
keep connecting and chatting normally.

The patch does not touch the provider-native Plan mode or proposed-plan
behaviour. Board threads are created with `interactionMode: "default"` and
`runtimeMode: "full-access"`. The board is a workspace-level planning surface
that sits beside native Plan mode, not a replacement for it.

## Baseline and ancestry

Current upstream baseline: `7544d3d2c8e0145018d9adb7a1a650333b75362a`
from `https://github.com/pingdotgg/t3code.git` (2026-09-06).

The original import used an unrelated-history bridge at `fdcbe886a` on top of
`2daff8c2`. This update rebases the planning commits after that bridge onto
current upstream. The old snapshot and bridge remain on the original branches;
they are not replayed into this branch. Future updates can rebase this branch
normally. Publishing this rewritten history requires a separate decision.

## Per-task agent selection

Cards optionally persist `modelSelection` using the ordinary T3 model contract.
The card dialog reuses the existing provider/model picker. Manual Run saves the
edited card before claiming and explicitly applies its resolved selection to the
draft. The runner uses task, project, then server default for implementation,
continuation, and review. Older cards without a selection still work.

Running, Diagnosing, and Reviewing cards cannot change their selection: the
editor preserves it and the filesystem save boundary rejects stale changes.
The runner now depends on `ServerSettingsService` for the server fallback.

`scripts/start-mtplx.sh` uses the existing OpenCode adapter, discovers MTPLX's
served model, and enables OpenCode and the MTPLX default in checkout-local dev
settings. See `docs/operations/mtplx-opencode.md`. No additional provider adapter
or global OpenCode configuration is installed.

## Upstream compatibility fixes

The full macOS test run exposed a session scanner path mismatch: canonical
`/private/var` candidates were compared only with `/var` exclusion roots.
`AgentSessionScanner.ts` now compares both forms. The provider registry
re-probe test counts its Codex commands without counting incidental Homebrew
discovery. Antigravity client file access now resolves the deepest existing
ancestor before checking containment, allowing new nested files under symlinked
roots and rejecting leaf symlinks that point outside the workspace.
Desktop tests must run without inherited `ELECTRON_RUN_AS_NODE`. On macOS,
use a canonical `TMPDIR` for upstream fixtures that compare emitted real paths
with their temporary directory spelling:

```bash
TMPDIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)" env -u ELECTRON_RUN_AS_NODE vp run -r --concurrency-limit 2 test
```

## Integration points

Files owned entirely by the patch:

| Path                                                               | Responsibility                                                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/agentBoard.ts`                             | Board file, card, runtime, runner-settings, worker/review result, and runner status schemas; the five RPC payloads.                                   |
| `packages/contracts/src/agentBoardWorkflow.ts`                     | `WORKFLOW.md` front-matter schema, runtime config, and defaults.                                                                                      |
| `packages/shared/src/agentBoardPrompts.ts`                         | Implementation / continuation / review prompt builders and the `agent-board-result` parsers. Shared by the server runner and the web manual-run path. |
| `apps/server/src/agentBoard/AgentBoardFileSystem.ts`               | Board load/save/claim/`setRunnerEnabled`, path containment, atomic writes.                                                                            |
| `apps/server/src/agentBoard/WorkflowFile.ts`                       | Reads and parses `WORKFLOW.md`, with per-project last-known-good.                                                                                     |
| `apps/server/src/agentBoard/boardScheduler.ts`                     | Pure selection, backoff, and card transitions; `RUNNER_OWNED_STATES`.                                                                                 |
| `apps/server/src/agentBoard/AgentBoardRunner.ts`                   | The runner service: tick, adopt, retry, claim, launch, review.                                                                                        |
| `apps/web/src/components/agentBoard/`                              | Panel, Kanban, table, dependency tree, card dialog, runner controls, decision answering, manual run hook, pure view model.                            |
| `apps/web/src/planningFeaturesState.ts`                            | The `Break` switch and its persisted state.                                                                                                           |
| `apps/web/src/routes/_chat.planning.$environmentId.$projectId.tsx` | The Planning route at `/planning/$environmentId/$projectId`.                                                                                          |

Upstream files the patch touches. These are the repair points:

| Path                                                                         | What the patch does there                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/index.ts`                                            | Re-exports the two board contract modules.                                                                                                                                                                                     |
| `packages/contracts/src/rpc.ts`                                              | Five `WS_METHODS` entries and their `Rpc.make` definitions: `projects.loadAgentBoard`, `projects.saveAgentBoard`, `projects.claimAgentBoardCard`, `projects.getAgentBoardRunnerStatus`, `projects.setAgentBoardRunnerEnabled`. |
| `packages/contracts/src/ipc.ts`                                              | The same five methods on the environment API surface.                                                                                                                                                                          |
| `apps/server/src/ws.ts`                                                      | The five RPC handlers. The claim handler refuses cards in `RUNNER_OWNED_STATES`; the setEnabled handler nudges the runner.                                                                                                     |
| `apps/server/src/auth/RpcAuthorization.ts`                                   | Scopes: load and runner-status are read scope, save / claim / setEnabled are operate scope.                                                                                                                                    |
| `apps/server/src/server.ts`                                                  | `AgentBoardFileSystemLive` in the workspace layer; `AgentBoardRunnerLive.pipe(Layer.provide(WorkflowFileLive))` inside `ReactorLayerLive`.                                                                                     |
| `apps/server/src/serverRuntimeStartup.ts`                                    | `agentBoardRunner.start()` in the `reactors.start` phase, scoped to `reactorScope`.                                                                                                                                            |
| `apps/server/integration/orphanedProviderSessionStartup.integration.test.ts` | A stub layer for `AgentBoardRunner`, matching the sibling reactor stubs.                                                                                                                                                       |
| `packages/client-runtime/src/state/projectCommands.ts`                       | Two query atom families (`loadAgentBoard`, `getAgentBoardRunnerStatus`) and three commands (`saveAgentBoard`, `claimAgentBoardCard`, `setAgentBoardRunnerEnabled`).                                                            |
| `apps/web/src/components/Sidebar.tsx`                                        | The Planning button on the project-picker row.                                                                                                                                                                                 |
| `apps/web/src/components/CommandPalette.tsx`                                 | The `action:planning` entry, which also offers to re-enable Planning while `Break` is pulled.                                                                                                                                  |
| `apps/web/src/routeTree.gen.ts`                                              | Generated. Regenerated by the Vite plugin; never edit by hand.                                                                                                                                                                 |

Docs and portable planning assets that move with the patch: `AGENTS.md`,
`WORKFLOW.md`, `PROJECT.md`, `CONTEXT.md`, `PATCH.md`, `docs/agents/`,
`docs/user/agent-board.md`, `docs/internals/agent-board-runner.md`, and a
project's own `.t3/agent-board.json`.

## Ownership rules worth keeping

- **The board file is the only durable runner state.** No SQLite table, no
  sidecar. A restart re-adopts in-flight cards from the board.
- **`runner.enabled` is operator-owned.** `save` drops the client's `runner`
  block and keeps the one on disk; `setRunnerEnabled` is the only writer. A
  client saving a stale board can no longer switch the runner off.
- **`Running` / `Diagnosing` / `Reviewing` are runner-owned.** The
  `projects.claimAgentBoardCard` handler refuses them. `AgentBoardFileSystem.claim`
  itself accepts `Ready` _or_ `Diagnosing`, because the runner re-launches a
  card whose first attempt died before it had a thread — the RPC boundary, not
  the file primitive, is where a manual claim is stopped.
- **Manual `Run` is off while the runner is on.** It would otherwise leave a
  card `Running` with no `implementationRunId` until the user pressed send, and
  the runner would take that for an orphan and start its own agent in the same
  worktree.
- **A whole-board save carries `expectedUpdatedAt`.** The panel sends the
  `updatedAt` of the board it was derived from; a mismatch is refused with a
  message starting `Agent board changed`, which the web matches on
  (`isBoardConflictError`) to reload and re-ask. Without it a stale snapshot
  would revert the runner's transitions on every other card. The prefix is part
  of the contract — see `docs/internals/agent-board-runner.md`.
- **The Planning surface is gated at render, not by a redirect.** The `Break`
  flag is read synchronously, so while it is pulled the board panel never
  mounts and cannot create `.t3/agent-board.json` in a project whose Planning is
  broken.

## Upstream break risks

- Route or layout changes under `_chat` break the Planning entry point and the
  route's header controls.
- WebSocket/RPC contract or `WS_METHODS` conventions changing breaks all five
  board methods and the client-runtime atoms.
- `thread.session-set` payload changes, or new/renamed `OrchestrationSession.status`
  literals, break turn-completion detection in `AgentBoardRunner.onEvent`.
- `GitWorkflowService.createWorktree` changing signature breaks card worktree
  creation.
- `thread.create` / `thread.turn.start` command shapes, `runtimeMode`, or
  `interactionMode` literals changing breaks the launch sequence.
- `ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot` or
  `defaultModelSelection` changing breaks project resolution; the runner parks
  cards at `Needs Decision` when it cannot find a model.
- Reactor layer or startup-phase restructuring drops `agentBoardRunner.start()`,
  which fails silently — the board simply never ticks.
- `WorkspacePaths` containment helpers changing breaks board path validation.
- Contract package schema conventions (`Schema.optionalKey`,
  `withDecodingDefault`) changing breaks board decoding of existing files.
- Component library or CSS changes affect the board views' layout.

## Known gaps

- `Break` stops the runner only for the project whose Planning route you are
  on. `runner.enabled` is per project, the `Break` flag is global to the
  browser, so another project's runner keeps going with its Planning surface
  hidden. Stop it from that project's own header.
- The manual `Run` affordance stays visible while the runner is enabled and
  only errors on click.
- Workspaces are never cleaned up automatically.

## Maintenance rule

A change that touches fork-specific planning behaviour updates this file in the
same task. A future repair agent should be able to read `PATCH.md` and know
where the patch attaches, what to verify, and which files stay portable.
