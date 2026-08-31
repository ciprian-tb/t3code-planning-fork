/**
 * AgentBoardFileSystem - project-local planning board storage.
 *
 * The board lives at exactly `.t3/agent-board.json` below a validated project
 * root. Every mutation is validated against `AgentBoardFile`, serialized behind
 * a single semaphore and written atomically, so a claim can never interleave
 * with a concurrent save.
 *
 * @module AgentBoardFileSystem
 */
import {
  AGENT_BOARD_RELATIVE_PATH,
  AgentBoardFile,
  AgentBoardFileError,
  type AgentBoardClaimInput,
  type AgentBoardClaimResult,
  type AgentBoardLoadInput,
  type AgentBoardLoadResult,
  type AgentBoardSaveInput,
  type AgentBoardSaveResult,
  type AgentBoardSetRunnerEnabledInput,
} from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

/** Service tag for project-local agent board storage. */
export class AgentBoardFileSystem extends Context.Service<
  AgentBoardFileSystem,
  {
    /** Read the board, optionally seeding an empty one when the file is absent. */
    readonly load: (
      input: AgentBoardLoadInput,
    ) => Effect.Effect<AgentBoardLoadResult, AgentBoardFileError>;
    /** Validate and atomically replace the board. */
    readonly save: (
      input: AgentBoardSaveInput,
    ) => Effect.Effect<AgentBoardSaveResult, AgentBoardFileError>;
    /** Flip `runner.enabled` on disk; the only writer of the operator-owned runner block. */
    readonly setRunnerEnabled: (
      input: AgentBoardSetRunnerEnabledInput,
    ) => Effect.Effect<AgentBoardSaveResult, AgentBoardFileError>;
    /** Move a `Ready` (or re-launched `Diagnosing`) card to `Running` and reserve its workspace. */
    readonly claim: (
      input: AgentBoardClaimInput,
    ) => Effect.Effect<AgentBoardClaimResult, AgentBoardFileError>;
  }
>()("t3/agentBoard/AgentBoardFileSystem") {}

const AgentBoardFileJson = fromJsonStringPretty(AgentBoardFile);
const decodeAgentBoardFile = Schema.decodeUnknownEffect(AgentBoardFile);
const decodeAgentBoardFileJson = Schema.decodeUnknownEffect(AgentBoardFileJson);
const encodeAgentBoardFileJson = Schema.encodeUnknownEffect(AgentBoardFileJson);

const boardError = (message: string, cause?: unknown): AgentBoardFileError =>
  new AgentBoardFileError({ message, cause });

/**
 * Card ids are user-authored, so they are reduced to `[A-Za-z0-9_-]` before
 * becoming a directory name: no id can produce a `.` or `/` segment that walks
 * out of `.t3/workspaces`.
 *
 * ponytail: two ids differing only in punctuation collide onto one directory;
 * add a short hash suffix if that ever bites.
 */
function agentBoardWorkspaceSegment(cardId: string): string {
  const segment = cardId
    .replaceAll(/[^a-zA-Z0-9_-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80);
  return segment.length > 0 ? segment : "card";
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  // Every operation takes this permit, including `load`: reads must not observe
  // a board mid-rewrite, and `load` itself writes when seeding a missing board.
  // ponytail: one process-wide lock covers every project's board; split per
  // project root if boards for different projects ever contend measurably.
  const mutations = yield* Semaphore.make(1);

  /**
   * `realPath` of the deepest existing ancestor with the still-missing tail
   * re-appended. `.t3/agent-board.json` and a card workspace do not exist yet
   * on the very write that creates them, so a plain `realPath` would fail with
   * `NotFound` and leave the containment check unenforced exactly when it
   * matters most.
   */
  const realPathAllowingMissing = (target: string): Effect.Effect<string, PlatformError> =>
    fileSystem.realPath(target).pipe(
      Effect.catch((cause) => {
        const parent = path.dirname(target);
        return cause.reason._tag === "NotFound" && parent !== target
          ? realPathAllowingMissing(parent).pipe(
              Effect.map((realParent) => path.join(realParent, path.basename(target))),
            )
          : Effect.fail(cause);
      }),
    );

  /**
   * `WorkspacePaths.resolveRelativePathWithinRoot` is lexical only, so a
   * symlinked `.t3` (or `.t3/workspaces`) pointing outside the project passes
   * it. Mirror the `realPath` containment check `WorkspaceFileSystem.readFile`
   * applies to workspace files.
   */
  const resolveWithinRoot = Effect.fn("AgentBoardFileSystem.resolveWithinRoot")(function* (
    projectRoot: string,
    relativePath: string,
  ) {
    const resolved = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: projectRoot, relativePath })
      .pipe(Effect.mapError((cause) => boardError(cause.message, cause)));
    const realRoot = yield* realPathAllowingMissing(projectRoot).pipe(
      Effect.mapError((cause) =>
        boardError(`Failed to resolve project root ${projectRoot}.`, cause),
      ),
    );
    const realTarget = yield* realPathAllowingMissing(resolved.absolutePath).pipe(
      Effect.mapError((cause) =>
        boardError(`Failed to resolve ${relativePath} in ${projectRoot}.`, cause),
      ),
    );
    const relativeReal = path.relative(realRoot, realTarget);
    if (
      relativeReal.length === 0 ||
      relativeReal === ".." ||
      relativeReal.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeReal)
    ) {
      return yield* boardError(
        `Agent board path '${relativePath}' resolves outside project root '${projectRoot}': ${realTarget}`,
      );
    }
    return resolved.absolutePath;
  });

  const resolveBoardPath = Effect.fn("AgentBoardFileSystem.resolveBoardPath")(function* (
    cwd: string,
  ) {
    const projectRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(cwd)
      .pipe(Effect.mapError((cause) => boardError(cause.message, cause)));
    return {
      projectRoot,
      absolutePath: yield* resolveWithinRoot(projectRoot, AGENT_BOARD_RELATIVE_PATH),
    };
  });

  const writeBoard = Effect.fn("AgentBoardFileSystem.writeBoard")(function* (
    absolutePath: string,
    board: AgentBoardFile,
  ) {
    const contents = yield* encodeAgentBoardFileJson(board).pipe(
      Effect.mapError((cause) =>
        boardError(`Agent board is not serializable: ${cause.message}`, cause),
      ),
    );
    yield* writeFileStringAtomically({ filePath: absolutePath, contents: `${contents}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) =>
        boardError(`Failed to write agent board at ${absolutePath}.`, cause),
      ),
    );
  });

  const decodeBoard = (board: unknown) =>
    decodeAgentBoardFile(board).pipe(
      Effect.mapError((cause) => boardError(`Invalid agent board: ${cause.message}`, cause)),
    );

  /** Unguarded read used by both the public `load` and `claim`. */
  const readBoard = Effect.fn("AgentBoardFileSystem.readBoard")(function* (
    input: AgentBoardLoadInput,
  ) {
    const { projectRoot, absolutePath } = yield* resolveBoardPath(input.cwd);
    const raw = yield* fileSystem
      .readFileString(absolutePath)
      .pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound" && input.createIfMissing === true
            ? Effect.succeed(null)
            : Effect.fail(boardError(`Failed to read agent board at ${absolutePath}.`, cause)),
        ),
      );

    if (raw === null) {
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const board = yield* decodeBoard({ projectRoot, createdAt: timestamp, updatedAt: timestamp });
      yield* writeBoard(absolutePath, board);
      return { projectRoot, absolutePath, board, created: true };
    }

    const board = yield* decodeAgentBoardFileJson(raw).pipe(
      Effect.mapError((cause) =>
        boardError(`Invalid agent board at ${absolutePath}: ${cause.message}`, cause),
      ),
    );
    return { projectRoot, absolutePath, board, created: false };
  });

  /** Unguarded validate-and-write used by both the public `save` and `claim`. */
  const persistBoard = Effect.fn("AgentBoardFileSystem.persistBoard")(function* (
    projectRoot: string,
    absolutePath: string,
    board: object,
  ) {
    const decoded = yield* decodeBoard({ ...board, projectRoot });
    yield* writeBoard(absolutePath, decoded);
    return decoded;
  });

  const load: AgentBoardFileSystem["Service"]["load"] = (input) =>
    mutations.withPermit(
      readBoard(input).pipe(
        Effect.map(
          (result): AgentBoardLoadResult => ({
            board: result.board,
            relativePath: AGENT_BOARD_RELATIVE_PATH,
            created: result.created,
          }),
        ),
      ),
    );

  // `runner` is operator-owned and only written by `setRunnerEnabled`. Clients
  // round-trip a whole board they may have snapshotted before a toggle, so
  // their copy of the block is dropped: disk wins, or the schema default does
  // when there is no board on disk yet.
  const save: AgentBoardFileSystem["Service"]["save"] = (input) =>
    mutations.withPermit(
      Effect.gen(function* () {
        const { projectRoot, absolutePath } = yield* resolveBoardPath(input.cwd);
        // A missing (or unreadable) board leaves `runner` off the object so the
        // schema default fills it; saving over a corrupt board still works.
        const onDisk = yield* readBoard({ cwd: input.cwd }).pipe(Effect.orElseSucceed(() => null));
        const { runner: _clientRunner, ...clientBoard } = input.board;
        const board = yield* persistBoard(
          projectRoot,
          absolutePath,
          onDisk === null ? clientBoard : { ...clientBoard, runner: onDisk.board.runner },
        );
        return { board, relativePath: AGENT_BOARD_RELATIVE_PATH } satisfies AgentBoardSaveResult;
      }),
    );

  const setRunnerEnabled: AgentBoardFileSystem["Service"]["setRunnerEnabled"] = (input) =>
    mutations.withPermit(
      Effect.gen(function* () {
        const loaded = yield* readBoard({ cwd: input.cwd });
        const board = yield* persistBoard(loaded.projectRoot, loaded.absolutePath, {
          ...loaded.board,
          runner: { ...loaded.board.runner, enabled: input.enabled },
        });
        return { board, relativePath: AGENT_BOARD_RELATIVE_PATH } satisfies AgentBoardSaveResult;
      }),
    );

  const claim: AgentBoardFileSystem["Service"]["claim"] = (input) =>
    mutations.withPermit(
      Effect.gen(function* () {
        const loaded = yield* readBoard({ cwd: input.cwd });
        const card = loaded.board.cards.find((candidate) => candidate.id === input.cardId);
        if (!card) {
          return yield* boardError(`Agent board card not found: ${input.cardId}`);
        }
        // `Diagnosing` is the runner re-launching a card whose first launch
        // failed before it had a thread; it needs the same workspace reservation.
        if (card.state !== "Ready" && card.state !== "Diagnosing") {
          return yield* boardError(
            `Only Ready or Diagnosing cards can be claimed. ${input.cardId} is ${card.state}.`,
          );
        }

        const workspacePath = `.t3/workspaces/${agentBoardWorkspaceSegment(card.id)}`;
        const workspaceAbsolutePath = yield* resolveWithinRoot(loaded.projectRoot, workspacePath);
        yield* fileSystem
          .makeDirectory(workspaceAbsolutePath, { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              boardError(`Failed to create card workspace at ${workspaceAbsolutePath}.`, cause),
            ),
          );

        const timestamp = DateTime.formatIso(yield* DateTime.now);
        const {
          currentError: _currentError,
          currentDecisionQuestion: _currentDecisionQuestion,
          ...runtime
        } = card.runtime;
        const nextBoard = {
          ...loaded.board,
          cards: loaded.board.cards.map((candidate) =>
            candidate.id === input.cardId
              ? {
                  ...candidate,
                  state: "Running",
                  updatedAt: timestamp,
                  runtime: {
                    ...runtime,
                    attemptCount: runtime.attemptCount + 1,
                    lastHeartbeatAt: timestamp,
                    workspacePath,
                  },
                }
              : candidate,
          ),
          updatedAt: timestamp,
        };

        const board = yield* persistBoard(loaded.projectRoot, loaded.absolutePath, nextBoard);
        const claimed = board.cards.find((candidate) => candidate.id === input.cardId);
        if (!claimed) {
          return yield* boardError(`Claimed card missing after save: ${input.cardId}`);
        }
        return {
          board,
          card: claimed,
          relativePath: AGENT_BOARD_RELATIVE_PATH,
          workspacePath,
        } satisfies AgentBoardClaimResult;
      }),
    );

  return AgentBoardFileSystem.of({ load, save, setRunnerEnabled, claim });
});

export const AgentBoardFileSystemLive = Layer.effect(AgentBoardFileSystem, make);
