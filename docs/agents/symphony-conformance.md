# Symphony Conformance

How this fork maps onto OpenAI Symphony's long-running project orchestration
model, and where it deliberately or accidentally differs.

Symphony's tracker is Linear; ours is `.t3/agent-board.json`. Symphony's workpad
is one issue comment; ours is a task record under `docs/agents/tasks/`. That
substitution is declared in `WORKFLOW.md` as `tracker.kind: t3-local` and is not
drift.

## What We Mirror

**A daemon runner.** `AgentBoardRunner`
(`apps/server/src/agentBoard/AgentBoardRunner.ts`) polls every project's board
and claims eligible work on its own. It is not a script a human runs per card.
It lives inside the T3 server — there is no second process to start — and it is
enabled per project through `runner.enabled`, which only the server writes.

**A typed workflow loader.** `WorkflowFile.ts` parses the `WORKFLOW.md` front
matter and decodes it with `AgentBoardWorkflowConfig`
(`packages/contracts/src/agentBoardWorkflow.ts`). Unknown keys are dropped at
any depth, so Symphony's `hooks:` and `codex:` blocks parse without error; every
value that is read is range-checked.

**Dynamic reload.** The file is re-read at the top of every tick. There is no
watcher and no restart. A file that stops parsing falls back to the last config
that parsed for that project (`workflowSource: last-known-good`), or to the
defaults if none ever did, and the error is surfaced in the Planning header. A
broken edit never crashes a tick and never stops an in-flight card.

**Retry and reconcile with backoff.** Failures move a card to `Diagnosing` with
`nextRetryAt`; `retryDelayMs` doubles from 1 s per attempt, capped by
`agent.max_retry_backoff_ms`. Every tick re-adopts the cards the board says the
runner owns, reading `implementationRunId` or `reviewRunId` by `runtime.phase`,
so a restart mid-run picks the work back up. The board file is the only durable
runner state; the in-memory scheduler map is expendable.

**A fresh review thread per review.** `startReview` always creates a new thread
(`Review <title>`) on the card's worktree, never the implementation thread, so
the reviewer begins with no implementation context. `changes-requested`
findings are handed to the implementer verbatim and count against
`agent.max_repair_cycles`.

Already mirrored before the runner landed, and still true: isolated per-card
workspaces (`.t3/workspaces/<key>` on `agent-board/<key>`), bounded concurrency
(default one card per project), one persistent workpad per card, a
workflow-defined hand-off state (`agent.on_success`, default `Review`, not
automatic merge), and operator-visible status in the Planning header.

## Current Gaps

**Lifecycle hooks.** Symphony's `after_create`, `before_run`, `after_run`, and
`before_remove` have no equivalent. A `hooks:` block in `WORKFLOW.md` parses and
is then discarded. There is no place to run setup, teardown, or per-workspace
provisioning around a card.

**The Codex App Server worker loop.** Symphony drives workers over the Codex App
Server protocol. This fork launches whatever provider the project's default
model selection points at, as an ordinary T3 thread
(`thread.create` + `thread.turn.start`). That buys the Chat UI, checkpoints, and
diffs for free, and costs the protocol-level conformance: outcomes arrive as an
`agent-board-result` block in assistant text, not as a structured worker reply.
A project with no default model parks its cards at `Needs Decision`.

**Unimplemented fallbacks in the board schema.** These fields decode, persist,
and round-trip, but nothing reads them. They are recorded here so nobody plans
against them:

- `runner.maxConcurrentCards` — concurrency comes from
  `agent.max_concurrent_agents` in `WORKFLOW.md`. The board field is never read.
- `runner.repairCycles` — repair budget comes from `agent.max_repair_cycles`.
  The board field is never read.
- `defaultView`, `graphLinks`, and `graphPosition` — the Planning views pick
  their own default, and the dependency tree is generated from each card's
  `dependencies`. No stored layout or hand-drawn edge is ever loaded.

`WORKFLOW.md` describes `runner.maxConcurrentCards` and `runner.repairCycles` as
fields `WORKFLOW.md` wins over. That is accurate in effect and generous in
detail: there is no path where they lose, because there is no path where they
are consulted.
