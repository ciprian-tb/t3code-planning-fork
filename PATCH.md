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

|                          |                                            |
| ------------------------ | ------------------------------------------ |
| Upstream baseline        | `2daff8c25adf701fddd062ae93b94cc57d420ec2` |
| Previous public fork tip | `fb6244ca7577ab1d88fdd3daea6a85882414f3b6` |
| Ancestry bridge commit   | `fdcbe886ac327ba3c1f5a8a775b61f6a6a8ed134` |

The fork and upstream have no common git ancestor. The bridge commit is an
`ours` merge of the old fork tip into the upstream baseline: the tree stays
byte-for-byte upstream, and both histories become ancestors. That is what makes
the public cutover a fast-forward instead of a force push.

To upgrade onto a newer upstream, repeat the shape:

```bash
git fetch <upstream-remote> main
git switch -c upgrade/next <upstream-remote>/main
git merge --strategy=ours --allow-unrelated-histories --no-edit \
  -m "chore: preserve planning fork history" main
# then port the patch by capability, file by file, using the table below
git merge-base --is-ancestor main HEAD
git merge-base --is-ancestor <upstream-remote>/main HEAD
```

Port by capability. Do not replay the old snapshot commit — most of the old
attachment files no longer exist upstream.

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
`docs/user/planning.md`, and a project's own `.t3/agent-board.json`.

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
- `save` is a whole-board last-writer-wins overwrite with no version check.
  Only the `runner` block is protected.
- Cards whose ids differ only in punctuation collide onto one workspace
  directory.
- Workspaces are never cleaned up automatically.

## Maintenance rule

A change that touches fork-specific planning behaviour updates this file in the
same task. A future repair agent should be able to read `PATCH.md` and know
where the patch attaches, what to verify, and which files stay portable.
