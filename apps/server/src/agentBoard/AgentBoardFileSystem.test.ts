import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import {
  AGENT_BOARD_RELATIVE_PATH,
  AgentBoardFile,
  type AgentBoardCardId,
} from "@t3tools/contracts";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { AgentBoardFileSystem, AgentBoardFileSystemLive } from "./AgentBoardFileSystem.ts";

// `provideMerge` so the tests themselves can reach FileSystem/Path to build fixtures.
const layer = AgentBoardFileSystemLive.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

const decodeBoard = Schema.decodeUnknownSync(AgentBoardFile);

const TIMESTAMP = "2026-08-30T10:00:00.000Z";

const cardId = (value: string): AgentBoardCardId => value as AgentBoardCardId;

const readyBoardWith = (projectRoot: string, id: string, title = "Ship the thing") =>
  decodeBoard({
    projectRoot,
    cards: [
      {
        id,
        title,
        state: "Ready",
        intentBrief: { intent: "Ship the thing" },
        runtime: { currentError: "boom", currentDecisionQuestion: "which way?" },
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });

const tempProjectRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "agent-board-fs-" });
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    AgentBoardFileSystem | FileSystem.FileSystem | Path.Path | Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(layer));

describe("AgentBoardFileSystem", () => {
  it.effect("creates a valid default board only when requested", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;

        const loaded = yield* service.load({ cwd, createIfMissing: true });
        expect(loaded.board.projectRoot).toBe(cwd);
        expect(loaded.board.cards).toEqual([]);
        expect(loaded.created).toBe(true);
        expect(loaded.relativePath).toBe(AGENT_BOARD_RELATIVE_PATH);

        const contents = yield* fs.readFileString(path.join(cwd, AGENT_BOARD_RELATIVE_PATH));
        expect(contents.endsWith("\n")).toBe(true);
        expect(contents).toContain('\n  "projectRoot"');

        const reloaded = yield* service.load({ cwd });
        expect(reloaded.created).toBe(false);
      }),
    ),
  );

  it.effect("fails when the board is missing and creation was not requested", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;

        expect(Exit.isFailure(yield* Effect.exit(service.load({ cwd })))).toBe(true);
        expect(yield* fs.exists(path.join(cwd, AGENT_BOARD_RELATIVE_PATH))).toBe(false);
      }),
    ),
  );

  it.effect("fails on malformed JSON without overwriting the file", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* tempProjectRoot;
        const boardPath = path.join(cwd, AGENT_BOARD_RELATIVE_PATH);
        yield* fs.makeDirectory(path.dirname(boardPath), { recursive: true });
        yield* fs.writeFileString(boardPath, "{ not json");
        const service = yield* AgentBoardFileSystem;

        const exit = yield* Effect.exit(service.load({ cwd, createIfMissing: true }));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* fs.readFileString(boardPath)).toBe("{ not json");
      }),
    ),
  );

  it.effect("rejects a Ready card without an intent brief and leaves the board untouched", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;

        const invalid = {
          schemaVersion: 1,
          projectRoot: cwd,
          defaultView: "kanban",
          runner: { maxConcurrentCards: 1, repairCycles: 3 },
          graphLinks: [],
          cards: [
            {
              id: "card-1",
              title: "Ready without a brief",
              state: "Ready",
              priority: 3,
              dependencies: [],
              parallelism: { safe: "false", conflictsWith: [], allowedWriteScopes: [] },
              runtime: { attemptCount: 0 },
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            },
          ],
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        } as unknown as AgentBoardFile;

        expect(Exit.isFailure(yield* Effect.exit(service.save({ cwd, board: invalid })))).toBe(
          true,
        );
        expect(yield* fs.exists(path.join(cwd, AGENT_BOARD_RELATIVE_PATH))).toBe(false);
      }),
    ),
  );

  it.effect("ignores a client's runner block and keeps the on-disk runner state", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;
        yield* service.save({ cwd, board: readyBoardWith(cwd, "card-1") });
        yield* service.setRunnerEnabled({ cwd, enabled: true });

        // A stale panel snapshot taken before the toggle, saved after it.
        const stale = decodeBoard({
          ...readyBoardWith(cwd, "card-1", "Renamed by the panel"),
          runner: { enabled: false, maxConcurrentCards: 4, repairCycles: 7 },
        });
        const saved = yield* service.save({ cwd, board: stale });

        expect(saved.board.runner).toEqual({
          enabled: true,
          maxConcurrentCards: 1,
          repairCycles: 3,
        });
        // Cards stay client-owned.
        expect(saved.board.cards[0]?.title).toBe("Renamed by the panel");
        const reloaded = yield* service.load({ cwd });
        expect(reloaded.board.runner.enabled).toBe(true);
        expect(reloaded.board.cards[0]?.title).toBe("Renamed by the panel");
      }),
    ),
  );

  it.effect("seeds the default runner block when the board file does not exist yet", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;

        const saved = yield* service.save({
          cwd,
          board: decodeBoard({
            ...readyBoardWith(cwd, "card-1"),
            runner: { enabled: true, maxConcurrentCards: 4, repairCycles: 7 },
          }),
        });
        expect(saved.board.runner).toEqual({
          enabled: false,
          maxConcurrentCards: 1,
          repairCycles: 3,
        });
      }),
    ),
  );

  it.effect("setRunnerEnabled is the only way to flip runner.enabled", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;
        yield* service.save({ cwd, board: readyBoardWith(cwd, "card-1") });

        const on = yield* service.setRunnerEnabled({ cwd, enabled: true });
        expect(on.board.runner.enabled).toBe(true);
        expect((yield* service.load({ cwd })).board.runner.enabled).toBe(true);
        // The rest of the board survives the patch.
        expect(on.board.cards[0]?.title).toBe("Ship the thing");
        expect(on.board.runner.maxConcurrentCards).toBe(1);

        const off = yield* service.setRunnerEnabled({ cwd, enabled: false });
        expect(off.board.runner.enabled).toBe(false);
        expect((yield* service.load({ cwd })).board.runner.enabled).toBe(false);
      }),
    ),
  );

  it.effect("serializes a card save against a concurrent runner toggle", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;
        yield* service.save({ cwd, board: readyBoardWith(cwd, "card-1") });

        // Whichever order the two mutations land in, neither may lose the
        // other's write: the toggle owns `runner`, the save owns `cards`.
        yield* Effect.all(
          [
            service.save({ cwd, board: readyBoardWith(cwd, "card-1", "Edited mid-toggle") }),
            service.setRunnerEnabled({ cwd, enabled: true }),
          ],
          { concurrency: "unbounded" },
        );

        const loaded = yield* service.load({ cwd });
        expect(loaded.board.runner.enabled).toBe(true);
        expect(loaded.board.cards[0]?.title).toBe("Edited mid-toggle");
      }),
    ),
  );

  it.effect("claims a Ready card into a workspace directory", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;
        yield* service.save({ cwd, board: readyBoardWith(cwd, "card-1") });

        const claimed = yield* service.claim({ cwd, cardId: cardId("card-1") });
        expect(claimed.workspacePath).toBe(".t3/workspaces/card-1");
        expect(claimed.card.state).toBe("Running");
        expect(claimed.card.runtime.attemptCount).toBe(1);
        expect(claimed.card.runtime.workspacePath).toBe(".t3/workspaces/card-1");
        expect(claimed.card.runtime.lastHeartbeatAt).toBeDefined();
        expect(claimed.card.runtime.currentError).toBeUndefined();
        expect(claimed.card.runtime.currentDecisionQuestion).toBeUndefined();

        const stat = yield* fs.stat(path.join(cwd, ".t3", "workspaces", "card-1"));
        expect(stat.type).toBe("Directory");

        const persisted = yield* service.load({ cwd });
        expect(persisted.board.cards[0]?.state).toBe("Running");
      }),
    ),
  );

  it.effect("allows only one concurrent claim of the same Ready card", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;
        yield* service.save({ cwd, board: readyBoardWith(cwd, "card-1") });

        const exits = yield* Effect.all(
          [
            service.claim({ cwd, cardId: cardId("card-1") }),
            service.claim({ cwd, cardId: cardId("card-1") }),
          ].map(Effect.exit),
          { concurrency: "unbounded" },
        );
        expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
        expect(exits.filter(Exit.isFailure)).toHaveLength(1);
      }),
    ),
  );

  it.effect("keeps traversal card ids inside the project workspaces directory", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;
        yield* service.save({ cwd, board: readyBoardWith(cwd, "../../etc/passwd") });

        const claimed = yield* service.claim({ cwd, cardId: cardId("../../etc/passwd") });
        expect(claimed.workspacePath.startsWith(".t3/workspaces/")).toBe(true);
        expect(claimed.workspacePath).not.toContain("..");
        expect(yield* fs.exists(path.join(cwd, claimed.workspacePath))).toBe(true);
      }),
    ),
  );

  it.effect("fails when the project root does not exist", () =>
    run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;

        // A traversal cwd resolves outside the temp root, where no project exists.
        const outside = path.join(cwd, "..", "agent-board-fs-missing");
        expect(
          Exit.isFailure(yield* Effect.exit(service.load({ cwd: outside, createIfMissing: true }))),
        ).toBe(true);
      }),
    ),
  );

  it.effect("rejects a symlinked .t3 that escapes the project root", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* tempProjectRoot;
        const outside = yield* tempProjectRoot;
        yield* fs.symlink(outside, path.join(cwd, ".t3"));
        const service = yield* AgentBoardFileSystem;

        expect(
          Exit.isFailure(yield* Effect.exit(service.load({ cwd, createIfMissing: true }))),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(service.save({ cwd, board: readyBoardWith(cwd, "card-1") })),
          ),
        ).toBe(true);
        // Nothing was written through the symlink.
        expect(yield* fs.exists(path.join(outside, "agent-board.json"))).toBe(false);
      }),
    ),
  );

  it.effect("rejects a symlinked .t3/workspaces when claiming", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* tempProjectRoot;
        const outside = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;
        yield* service.save({ cwd, board: readyBoardWith(cwd, "card-1") });
        yield* fs.symlink(outside, path.join(cwd, ".t3", "workspaces"));

        expect(
          Exit.isFailure(yield* Effect.exit(service.claim({ cwd, cardId: cardId("card-1") }))),
        ).toBe(true);
        expect(yield* fs.exists(path.join(outside, "card-1"))).toBe(false);
        // The card stays claimable.
        const loaded = yield* service.load({ cwd });
        expect(loaded.board.cards[0]?.state).toBe("Ready");
      }),
    ),
  );

  it.effect("refuses to claim a card that is not Ready or not present", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* tempProjectRoot;
        const service = yield* AgentBoardFileSystem;
        yield* service.save({
          cwd,
          board: decodeBoard({
            projectRoot: cwd,
            cards: [
              {
                id: "card-1",
                title: "Not ready",
                state: "Backlog",
                createdAt: TIMESTAMP,
                updatedAt: TIMESTAMP,
              },
            ],
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          }),
        });

        expect(
          Exit.isFailure(yield* Effect.exit(service.claim({ cwd, cardId: cardId("card-1") }))),
        ).toBe(true);
        expect(
          Exit.isFailure(yield* Effect.exit(service.claim({ cwd, cardId: cardId("nope") }))),
        ).toBe(true);
      }),
    ),
  );
});
