# Agent board runner

> For maintainers. Using T3 Code? See [the agent board](../user/agent-board.md).

Fork-specific. The runner is an Effect service, [AgentBoardRunner.ts][runner], registered inside
`ReactorLayerLive` and started in the `reactors.start` phase. It reads a project's
`.t3/agent-board.json` and `WORKFLOW.md`, claims `Ready` cards, runs each in its own git worktree
through ordinary T3 threads, and writes every state change back to the board file.

This page is about **ownership**: which layer is allowed to write which card, and what stops two
writers from fighting over one. The workflow contract itself is documented in `WORKFLOW.md`; the
product intent is in `PROJECT.md`.

## The tick is the whole state machine

One pass, `tickUnlocked`, does everything for one project, in order:

1. reload `WORKFLOW.md` and stamp `lastTickMillis` (before any early return, or a project with no
   board file would look due forever);
2. if `runner.enabled` is false, stop every tracked thread and return;
3. drop cards the user dragged out of a runner-owned state, stopping their threads;
4. adopt every card the board says the runner owns, and settle any turn that has finished;
5. fire the retries whose `nextRetryAt` has passed;
6. claim what fits in the concurrency budget, via `selectClaimableCards`.

Everything is serialized by one `Semaphore` permit covering all projects. Ticks are IO-light and
rare, so a single lock is enough; splitting it per root is the upgrade if that stops holding.

### One sweep, per-project gating

There is exactly one timer: `SCHEDULER_INTERVAL`, a 1 s sleep-and-repeat forked at `start`. Each
sweep (`pollAll`) walks the known roots and ticks only the ones where
`now - lastTickMillis >= polling.intervalMs`, so a project's `WORKFLOW.md` decides its own cadence
without owning a fiber. Every 15 s (`DISCOVERY_INTERVAL_MS`) the sweep also re-reads the project
list to pick up new roots and to evict roots that no longer exist and have nothing in flight.

### Events nudge, they never settle

`start` subscribes to `engine.streamDomainEvents` through a `DrainableWorker`. `onEvent` ignores
everything except a `thread.session-set` whose session has no active turn and has reached a settled
status, and even then it does nothing but run a tick for that thread's root. It never parses a
result block, never transitions a card, and never touches the tracked map itself.

That is deliberate. Turn completion has exactly one code path — the adopt-and-settle loop inside the
tick — so a racing event and poll cannot both settle the same turn. The event is a latency
optimisation over the poll interval, nothing more.

`AgentBoardRunner.nudge(root)` is the other way in: it marks a root due on the next sweep. The
`projects.setAgentBoardRunnerEnabled` handler calls it after flipping the flag, so turning the
runner on takes effect in about a second instead of at the next poll.

## Runner ownership

`RUNNER_OWNED_STATES` — `Running`, `Diagnosing`, `Reviewing` — is defined in
[boardScheduler.ts][scheduler]:

```ts
/** States where a runner turn owns the card; they consume a concurrency slot. */
export const RUNNER_OWNED_STATES: ReadonlySet<AgentBoardState> = new Set([
  "Running",
  "Diagnosing",
  "Reviewing",
]);
```

It lives in the server, **not** in `packages/contracts`, and that is not an oversight. Contracts are
importable by the web app; this set is a server-side authorization rule. Keeping it here means the
Planning UI cannot grow a client-side copy that drifts from the rule the RPC actually enforces. If
you find yourself wanting it in contracts, you are about to move an authorization decision into the
client.

Three places consume it:

- [ws.ts][ws] — the `projects.claimAgentBoardCard` handler refuses a card in one of these states.
- [AgentBoardRunner.ts][runner] — `saveCard` only patches a card still in a runner-owned state or
  `Ready`, so a card the user has since dragged elsewhere is left exactly as they left it; the
  adopt loop uses the same set to decide what to pick up.
- `selectClaimableCards` — cards in these states are what consume the concurrency slots.

## The manual phase

`runtime.phase: "manual"` means a human pressed **Run** in the Planning UI and owns the card from
then on. The web writes it (`cardWithLaunchedRun` and `cardWithLaunchFailure` in
[agentBoardModel.ts][model], via [useRunAgentBoardCard.ts][manualrun]); the server honours it through
`isManual` in [AgentBoardRunner.ts][runner]:

```ts
/** A human ran this card from the UI and owns its thread; the runner keeps out. */
const isManual = (card: AgentBoardCard): boolean => card.runtime.phase === "manual";
```

The runner checks it in three places, and in each it does nothing at all:

- the drag-out pass skips manual cards, so their thread is never stopped — it is not the runner's
  thread to stop;
- the adopt loop skips them *before* the "no thread id recorded" park, because a manual card may
  legitimately have no runner-recorded thread;
- the retry pass skips manual `Diagnosing` cards, since the web parks a failed manual launch there
  too.

So the runner never adopts, continues, parks, or stops a manual card. Moving it on to `Review` or
`Done` is the human's job. Note that a failed manual launch deliberately records **no** run id: the
thread it opened is a client-side draft until the user presses Send, and handing the runner the id
of a worker that never existed would be worse than recording nothing.

## The save precondition

`AgentBoardSaveInput.expectedUpdatedAt` is optimistic concurrency, checked in
[AgentBoardFileSystem.ts][fs] as **exact string equality** against the on-disk `updatedAt`. Not a
timestamp comparison, not a tolerance — the same string, or the save is refused.

It exists because every board save from the panel ships the *whole* board. Without the check, a user
editing one card from a snapshot taken thirty seconds ago would silently roll back every transition
the runner made to *other* cards in the meantime. The panel therefore sends the `updatedAt` of the
board that was on screen before the edit, never the one the edit just stamped.

On mismatch the server fails with a message that begins `Agent board changed`:

```ts
// Prefix is load-bearing: clients match on it to offer a reload.
return yield* boardError(
  `Agent board changed on disk since this view loaded it (expected ${input.expectedUpdatedAt}, found ${onDisk.updatedAt}). Reload the board and try again.`,
);
```

**That prefix is a cross-layer contract.** `isBoardConflictError` in [agentBoardModel.ts][model] is
a `startsWith("Agent board changed")` test, and `AgentBoardPanel` uses it to tell a stale snapshot
apart from a broken write: on a conflict it drops the adopted board, refreshes, and asks the user to
redo the edit; on anything else it reports a save failure. Reword that message and the panel
silently degrades to "Board save failed" for the one case it knows how to recover from. If you must
change the wording, change the predicate in the same commit.

Two related rules in the same file:

- `save` drops whatever `runner` block the client sent and keeps the one on disk.
  `setRunnerEnabled` is the only writer of that block, so a stale tab cannot switch the runner off
  by saving a card edit. Only a *missing* board omits `runner` entirely, letting the schema default
  fill it; a corrupt or unreadable board fails the save instead.
- `modify` is the server-internal read-modify-write and takes the mutation permit for both halves.
  The runner uses it rather than `load` + `save`, because those are two critical sections and a
  client write can slot between them.

## The claim path

Claiming is two layers, and only the outer one is a safety layer.

`AgentBoardFileSystem.claim` accepts `Ready` **or** `Diagnosing`. `Diagnosing` is there for exactly
one case: the runner re-launching a card whose first attempt died before it had a thread, which
needs the same workspace reservation. Anything else — `Draft`, `Backlog`, `Review` — is refused
here.

The `projects.claimAgentBoardCard` handler in [ws.ts][ws] narrows that for clients. It refuses:

- any card in `RUNNER_OWNED_STATES`, which removes `Diagnosing` from a client's reach and stops a
  manual claim from starting a second agent in a worktree the runner is already using;
- **any** claim at all while `board.runner.enabled` is true, because a `Ready` card is the runner's
  next claim and the client's own view of the board is up to a poll interval stale.

Through the RPC, therefore, only a `Ready` card on a project whose runner is off can be claimed.

`runCardError` in [agentBoardModel.ts][model] checks the same two conditions on the client. It is
the friendly layer: it explains the refusal in words before the round trip. It is not what makes the
rule true, and the server must keep enforcing both even if the button is disabled.

## Why there is no heartbeat

There used to be a heartbeat pass at the end of every tick: while any card was tracked, it reloaded
the board, stamped `lastHeartbeatAt` on each tracked card, and wrote the whole file back. It was
removed. `runtime.lastHeartbeatAt` has no readers — nothing in the server or the UI branches on it —
so the pass bought nothing and cost a full board rewrite per project per polling interval, with a
fresh `updatedAt` each time that a concurrent panel save then had to lose to.

Liveness is reported instead by `status.lastTickAt` in `AgentBoardRunnerStatus`, which is in-memory
per project and costs nothing to serve. The Planning header renders it as `last tick …` beside the
workflow source and the active-card count. If the runner has stopped ticking, that line is where it
shows.

Per-transition stamping stays: `transition` and `patchCard` in [boardScheduler.ts][scheduler] and
`claim` in [AgentBoardFileSystem.ts][fs] all set `lastHeartbeatAt` when they are already writing the
card. The removal was of the periodic write, not of the field.

## Related

- [Glossary](./glossary.md) — agent board vocabulary
- [Architecture overview](./overview.md)
- `WORKFLOW.md` — the runtime contract the runner reads
- `PATCH.md` — where the fork attaches to upstream, and what to repair after an upgrade

[runner]: ../../apps/server/src/agentBoard/AgentBoardRunner.ts
[scheduler]: ../../apps/server/src/agentBoard/boardScheduler.ts
[fs]: ../../apps/server/src/agentBoard/AgentBoardFileSystem.ts
[ws]: ../../apps/server/src/ws.ts
[model]: ../../apps/web/src/components/agentBoard/agentBoardModel.ts
[manualrun]: ../../apps/web/src/components/agentBoard/useRunAgentBoardCard.ts
