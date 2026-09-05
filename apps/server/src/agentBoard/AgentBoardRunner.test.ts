import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  AgentBoardFile,
  type AgentBoardCardId,
  type OrchestrationProject,
  type ThreadId,
} from "@t3tools/contracts";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { AgentBoardFileSystem, AgentBoardFileSystemLive } from "./AgentBoardFileSystem.ts";
import { AgentBoardRunner, AgentBoardRunnerLive } from "./AgentBoardRunner.ts";
import { WorkflowFile, make as makeWorkflowFile } from "./WorkflowFile.ts";
import { makeHarness } from "./testing/runnerHarness.ts";

const NOW = "2026-08-30T00:00:00.000Z";
const CARD = "CARD-1" as AgentBoardCardId;
const DONE = '```agent-board-result\n{"outcome":"done","summary":"implemented"}\n```';
const APPROVED = '```agent-board-result\n{"outcome":"approved","summary":"lgtm"}\n```';
const CHANGES =
  '```agent-board-result\n{"outcome":"changes-requested","summary":"nope","findings":["add a test"]}\n```';
const DECIDE =
  '```agent-board-result\n{"outcome":"needs-decision","summary":"?","question":"Postgres or SQLite?"}\n```';

const decodeBoard = Schema.decodeUnknownSync(AgentBoardFile);

/**
 * `TestClock.adjust` starts the scheduler's sweep but cannot drive its async
 * file IO to completion. Each `read` is a real filesystem round-trip, so the
 * loop itself is the yield that lets the forked tick finish.
 */
const eventually = <A, E>(read: Effect.Effect<A, E>, ok: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = yield* read;
      if (ok(value)) return value;
      yield* Effect.yieldNow;
    }
    return yield* read;
  });

/** Give a forked tick every chance to land before asserting it did not run. */
const settle = <A, E>(read: Effect.Effect<A, E>) =>
  eventually(read, () => false).pipe(Effect.asVoid);

const readyBoard = (root: string, enabled: boolean): AgentBoardFile =>
  decodeBoard({
    schemaVersion: 1,
    projectRoot: root,
    defaultView: "kanban",
    runner: { enabled, maxConcurrentCards: 1, repairCycles: 3 },
    cards: [
      {
        id: CARD,
        title: "Ship it",
        state: "Ready",
        priority: 1,
        intentBrief: { intent: "ship", acceptanceCriteria: ["works"] },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

/**
 * A tick always starts by loading the workflow, so counting loads per root is
 * the cheapest observable "this root was ticked".
 */
const countingWorkflowFile = (loads: Map<string, number>) =>
  Layer.effect(
    WorkflowFile,
    makeWorkflowFile.pipe(
      Effect.map((service) =>
        WorkflowFile.of({
          load: (root) =>
            Effect.sync(() => loads.set(root, (loads.get(root) ?? 0) + 1)).pipe(
              Effect.andThen(() => service.load(root)),
            ),
        }),
      ),
    ),
  );

const setup = (opts: { workflow?: string; model?: boolean; enabled?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-board-runner-" });
    yield* fs.makeDirectory(path.join(root, ".git"));
    if (opts.workflow !== undefined) {
      yield* fs.writeFileString(path.join(root, "WORKFLOW.md"), opts.workflow);
    }
    const project = {
      id: "proj",
      title: "P",
      workspaceRoot: root,
      defaultModelSelection:
        opts.model === false ? null : { instanceId: "codex", model: "gpt-5", options: [] },
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    } as unknown as OrchestrationProject;
    const harness = yield* makeHarness(project);

    const workflowLoads = new Map<string, number>();
    const build = () =>
      Layer.build(
        AgentBoardRunnerLive.pipe(
          Layer.provide(harness.layer),
          Layer.provideMerge(AgentBoardFileSystemLive.pipe(Layer.provide(WorkspacePaths.layer))),
          Layer.provideMerge(countingWorkflowFile(workflowLoads)),
          Layer.provide(NodeServices.layer),
        ),
      );

    const runtime = yield* build();
    const runner = Context.get(runtime, AgentBoardRunner);
    const boards = Context.get(runtime, AgentBoardFileSystem);
    const enabled = opts.enabled ?? true;
    // `save` never writes the runner block, so the flag goes through its owner.
    yield* boards.save({ cwd: root, board: readyBoard(root, enabled) });
    if (enabled) yield* boards.setRunnerEnabled({ cwd: root, enabled: true });
    yield* runner.start();

    const card = () =>
      boards
        .load({ cwd: root })
        .pipe(Effect.map((loaded) => loaded.board.cards.find((c) => c.id === CARD)!));
    const threadIds = () =>
      Ref.get(harness.commands).pipe(
        Effect.map((cs) =>
          cs
            .filter((c) => c.type === "thread.create")
            .map((c) => (c as { readonly threadId: ThreadId }).threadId),
        ),
      );
    const patchBoard = (patch: (board: AgentBoardFile) => AgentBoardFile) =>
      boards.load({ cwd: root }).pipe(
        Effect.flatMap((loaded) => boards.save({ cwd: root, board: patch(loaded.board) })),
        Effect.asVoid,
      );
    const ticksOf = (target: string) => Effect.sync(() => workflowLoads.get(target) ?? 0);
    return { root, harness, runner, boards, card, threadIds, build, patchBoard, ticksOf };
  });

describe("AgentBoardRunner", () => {
  it.effect("does nothing when runner.enabled is false", () =>
    Effect.gen(function* () {
      const s = yield* setup({ enabled: false });
      yield* s.runner.tick(s.root);
      expect((yield* s.card()).state).toBe("Ready");
      expect(yield* s.threadIds()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("claims a Ready card, creates a worktree thread, and starts the first turn", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      yield* s.runner.tick(s.root);
      const card = yield* s.card();
      expect(card.state).toBe("Running");
      expect(card.runtime.phase).toBe("implementing");
      expect(card.runtime.turnCount).toBe(1);
      expect(card.runtime.branchName).toBe("agent-board/CARD-1");
      const cmds = yield* Ref.get(s.harness.commands);
      expect(cmds.map((c) => c.type)).toEqual(["thread.create", "thread.turn.start"]);
      const create = cmds[0] as Extract<(typeof cmds)[number], { type: "thread.create" }>;
      expect(create.worktreePath).toContain(".t3/workspaces/CARD-1");
      expect(create.runtimeMode).toBe("full-access");
      expect(card.runtime.implementationRunId).toBe(create.threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("done -> fresh review thread -> approved -> Review", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      yield* s.runner.tick(s.root);
      const [impl] = yield* s.threadIds();
      yield* s.harness.finishTurn(impl!, { text: DONE });
      yield* s.runner.tick(s.root);
      let card = yield* s.card();
      expect(card.state).toBe("Reviewing");
      const ids = yield* s.threadIds();
      expect(ids).toHaveLength(2);
      expect(ids[1]).not.toBe(impl);
      expect(card.runtime.reviewRunId).toBe(ids[1]);
      yield* s.harness.finishTurn(ids[1]!, { text: APPROVED });
      yield* s.runner.tick(s.root);
      card = yield* s.card();
      expect(card.state).toBe("Review");
      expect(card.runtime.lastResultSummary).toBe("lgtm");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "changes-requested -> repair turn on the implementation thread, bounded by max_repair_cycles",
    () =>
      Effect.gen(function* () {
        const s = yield* setup({
          workflow: "---\nagent:\n  max_repair_cycles: 1\n  on_success: Done\n---\n",
        });
        yield* s.runner.tick(s.root);
        const [impl] = yield* s.threadIds();
        yield* s.harness.finishTurn(impl!, { text: DONE });
        yield* s.runner.tick(s.root);
        const [, review] = yield* s.threadIds();
        yield* s.harness.finishTurn(review!, { text: CHANGES });
        yield* s.runner.tick(s.root);
        let card = yield* s.card();
        expect(card.state).toBe("Running");
        expect(card.runtime.repairCycleCount).toBe(1);
        expect(card.runtime.reviewFindings).toEqual(["add a test"]);
        const cmds = yield* Ref.get(s.harness.commands);
        const last = cmds.at(-1) as Extract<(typeof cmds)[number], { type: "thread.turn.start" }>;
        expect(last.threadId).toBe(impl);
        expect(last.message.text).toContain("add a test");

        yield* s.harness.finishTurn(impl!, { text: DONE });
        yield* s.runner.tick(s.root);
        const [, , review2] = yield* s.threadIds();
        yield* s.harness.finishTurn(review2!, { text: CHANGES });
        yield* s.runner.tick(s.root);
        card = yield* s.card();
        expect(card.state).toBe("Needs Decision");
        expect(card.runtime.currentDecisionQuestion).toContain("repair cycles");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("turn error -> Diagnosing with backoff, then a continuation turn when due", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      yield* s.runner.tick(s.root);
      const [impl] = yield* s.threadIds();
      yield* s.harness.finishTurn(impl!, { error: "typecheck failed" });
      yield* s.runner.tick(s.root);
      let card = yield* s.card();
      expect(card.state).toBe("Diagnosing");
      expect(card.runtime.currentError).toBe("typecheck failed");
      expect(card.runtime.nextRetryAt).toBeDefined();
      // Let the first backoff (1s) elapse so the retry is due.
      yield* TestClock.adjust(Duration.seconds(5));
      yield* s.runner.tick(s.root);
      card = yield* s.card();
      expect(card.state).toBe("Running");
      const last = (yield* Ref.get(s.harness.commands)).at(-1)!;
      expect(last.type).toBe("thread.turn.start");
      expect((last as { readonly message: { readonly text: string } }).message.text).toContain(
        "typecheck failed",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("needs-decision result stops the card with the question", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      yield* s.runner.tick(s.root);
      const [impl] = yield* s.threadIds();
      yield* s.harness.finishTurn(impl!, { text: DECIDE });
      yield* s.runner.tick(s.root);
      const card = yield* s.card();
      expect(card.state).toBe("Needs Decision");
      expect(card.runtime.currentDecisionQuestion).toBe("Postgres or SQLite?");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("missing project model -> Needs Decision without creating a thread", () =>
    Effect.gen(function* () {
      const s = yield* setup({ model: false });
      yield* s.runner.tick(s.root);
      expect((yield* s.card()).state).toBe("Needs Decision");
      expect(yield* s.threadIds()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("user moving a Running card to Canceled interrupts and stops the worker", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      yield* s.runner.tick(s.root);
      yield* s.patchBoard((board) => ({
        ...board,
        cards: board.cards.map((c) => ({ ...c, state: "Canceled" as const })),
      }));
      yield* s.runner.tick(s.root);
      const types = (yield* Ref.get(s.harness.commands)).map((c) => c.type);
      expect(types.slice(-2)).toEqual(["thread.turn.interrupt", "thread.session.stop"]);
      expect((yield* s.runner.status(s.root)).activeCardIds).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a nudge forces a tick before the polling interval elapses", () =>
    Effect.gen(function* () {
      const s = yield* setup({ enabled: false });
      yield* s.runner.tick(s.root);
      yield* s.boards.setRunnerEnabled({ cwd: s.root, enabled: true });

      // Control: the polling interval (15s) has not elapsed, so nothing happens.
      yield* TestClock.adjust(Duration.seconds(1));
      yield* settle(s.card());
      expect((yield* s.card()).state).toBe("Ready");

      yield* s.runner.nudge(s.root);
      yield* TestClock.adjust(Duration.seconds(1));
      expect((yield* eventually(s.card(), (c) => c.state === "Running")).state).toBe("Running");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a root with no board file is not re-ticked every sweep", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      const fs = yield* FileSystem.FileSystem;
      // No `.t3/agent-board.json`, so every tick bails out early.
      const bare = yield* fs.makeTempDirectoryScoped({ prefix: "agent-board-bare-" });

      yield* s.runner.nudge(bare);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* settle(s.ticksOf(bare));
      const ticked = yield* s.ticksOf(bare);
      expect(ticked).toBeGreaterThan(0);

      // Well inside the 15s default polling interval: no further ticks.
      yield* TestClock.adjust(Duration.seconds(5));
      yield* settle(s.ticksOf(bare));
      expect(yield* s.ticksOf(bare)).toBe(ticked);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("status does not enroll an unknown root in the polling set", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      const fs = yield* FileSystem.FileSystem;
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "agent-board-status-" });

      yield* s.runner.status(other);
      const afterStatus = yield* s.ticksOf(other);

      yield* TestClock.adjust(Duration.seconds(1));
      yield* settle(s.ticksOf(other));
      expect(yield* s.ticksOf(other)).toBe(afterStatus);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a root that leaves the project list with nothing in flight stops being polled", () =>
    Effect.gen(function* () {
      const s = yield* setup({ enabled: false });
      yield* s.runner.tick(s.root);
      yield* s.harness.hideProject;

      // One sweep past the discovery interval: the root is pruned.
      yield* TestClock.adjust(Duration.seconds(20));
      yield* settle(s.ticksOf(s.root));
      const pruned = yield* s.ticksOf(s.root);

      yield* TestClock.adjust(Duration.seconds(40));
      yield* settle(s.ticksOf(s.root));
      expect(yield* s.ticksOf(s.root)).toBe(pruned);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a failed projection read backs the card off instead of parking it", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      yield* s.harness.failNextProjectLookup;
      yield* s.runner.tick(s.root);
      const card = yield* s.card();
      expect(card.state).toBe("Diagnosing");
      expect(card.runtime.currentError).toContain("projection unavailable");
      expect(card.runtime.currentDecisionQuestion).toBeUndefined();
      expect(yield* s.threadIds()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a pre-launch failure re-launches when the retry falls due", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      yield* s.harness.failNextProjectLookup;
      yield* s.runner.tick(s.root);
      expect((yield* s.card()).state).toBe("Diagnosing");
      // The card was never launched, so the retry has to claim it, not continue it.
      yield* TestClock.adjust(Duration.seconds(5));
      yield* s.runner.tick(s.root);
      const card = yield* s.card();
      expect(card.state).toBe("Running");
      expect(yield* s.threadIds()).toHaveLength(1);
      expect(card.runtime.implementationRunId).toBe((yield* s.threadIds())[0]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a failed worker shell read backs the card off instead of parking it", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      yield* s.runner.tick(s.root);
      expect((yield* s.card()).state).toBe("Running");
      yield* s.harness.failNextThreadShellLookup;
      yield* s.runner.tick(s.root);
      const card = yield* s.card();
      expect(card.state).toBe("Diagnosing");
      expect(card.runtime.currentError).toContain("thread shell unavailable");
      expect(card.runtime.currentDecisionQuestion).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a card dragged to Canceled mid-launch stays Canceled and its thread is stopped", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      // Runs after the claim, before the `launched` save: exactly the window a
      // `git worktree add` leaves open for the user to drag the card away.
      yield* s.harness.duringNextWorktree(
        s
          .patchBoard((board) => ({
            ...board,
            cards: board.cards.map((c) => ({ ...c, state: "Canceled" as const })),
          }))
          .pipe(Effect.orDie),
      );
      yield* s.runner.tick(s.root);

      const canceled = yield* s.card();
      expect(canceled.state).toBe("Canceled");
      expect(canceled.runtime.phase).toBeUndefined();

      // The thread the runner started is still tracked, so the next tick stops it.
      yield* s.runner.tick(s.root);
      const types = (yield* Ref.get(s.harness.commands)).map((c) => c.type);
      expect(types.slice(-2)).toEqual(["thread.turn.interrupt", "thread.session.stop"]);
      expect((yield* s.runner.status(s.root)).activeCardIds).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restart recovery re-tracks a Running card from board fields", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      yield* s.runner.tick(s.root);
      const [impl] = yield* s.threadIds();
      // New runner instance, same board + harness state.
      const runner2 = Context.get(yield* s.build(), AgentBoardRunner);
      yield* runner2.start();
      yield* runner2.tick(s.root);
      expect((yield* runner2.status(s.root)).activeCardIds).toEqual([CARD]);
      yield* s.harness.finishTurn(impl!, { text: DONE });
      yield* runner2.tick(s.root);
      expect((yield* s.card()).state).toBe("Reviewing");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
