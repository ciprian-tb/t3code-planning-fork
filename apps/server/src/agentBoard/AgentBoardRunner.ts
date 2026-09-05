/**
 * AgentBoardRunner - drives `Ready` agent-board cards to a reviewed result.
 *
 * One pass (`tick`) is the whole state machine: adopt every card the board says
 * the runner owns, settle any worker turn that finished, fire due retries, then
 * claim what fits in the concurrency budget. The board file is the only durable
 * state, so a restart re-adopts in-flight cards from `implementationRunId` /
 * `reviewRunId` and keeps going.
 *
 * `thread.session-set` events only *nudge* a tick; they never carry their own
 * completion path. One code path means a settled turn cannot be handled twice
 * by a racing event and poll.
 *
 * @module AgentBoardRunner
 */
import {
  CommandId,
  MessageId,
  RuntimeSessionId,
  ThreadId,
  type AgentBoardCard,
  type AgentBoardCardId,
  type AgentBoardRunnerStatus,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import {
  buildContinuationPrompt,
  buildImplementationPrompt,
  buildReviewPrompt,
  implementationThreadTitle,
  parseReviewResult,
  parseWorkerResult,
  reviewThreadTitle,
  type ContinuationReason,
} from "@t3tools/shared/agentBoardPrompts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { AgentBoardFileSystem } from "./AgentBoardFileSystem.ts";
import {
  RUNNER_OWNED_STATES,
  patchCard,
  retryDelayMs,
  selectClaimableCards,
  transition,
} from "./boardScheduler.ts";
import { WorkflowFile, type LoadedWorkflow } from "./WorkflowFile.ts";

/** Which leg of the card a tracked worker thread belongs to. */
type Role = "implementation" | "review";

interface Tracked {
  readonly threadId: ThreadId;
  readonly role: Role;
}

interface ProjectState {
  readonly tracked: Map<AgentBoardCardId, Tracked>;
  workflow: LoadedWorkflow;
  lastTickAt?: string;
  lastTickMillis?: number;
}

export class AgentBoardRunner extends Context.Service<
  AgentBoardRunner,
  {
    /** Subscribe to turn completions and start the polling scheduler. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One synchronous pass over a project's board. */
    readonly tick: (projectRoot: string) => Effect.Effect<void>;
    readonly status: (projectRoot: string) => Effect.Effect<AgentBoardRunnerStatus>;
    /** Ask the scheduler to tick this project on its next sweep. */
    readonly nudge: (projectRoot: string) => Effect.Effect<void>;
  }
>()("t3/agentBoard/AgentBoardRunner") {}

/** A turn is finished when the session has no active turn and settled here. */
const SETTLED_STATUSES: ReadonlySet<OrchestrationSessionStatus> = new Set([
  "ready",
  "error",
  "stopped",
]);

const SCHEDULER_INTERVAL = Duration.seconds(1);
/** How often the scheduler re-reads the project list to discover new roots. */
const DISCOVERY_INTERVAL_MS = 15_000;

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/**
 * Interruption is the runtime stopping us, never a card failing, so it is
 * always re-raised; the cast is sound because an interrupt-only cause carries
 * no failure value.
 */
const catchNonInterrupt = <A, E, R, A2, E2, R2>(
  self: Effect.Effect<A, E, R>,
  handle: (cause: Cause.Cause<E>) => Effect.Effect<A2, E2, R2>,
): Effect.Effect<A | A2, E2, R | R2> =>
  self.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : handle(cause),
    ),
  );

/** Board strings are `TrimmedNonEmptyString`; never persist blank or padded text. */
const text = (value: string, fallback: string): string => value.trim() || fallback;

export const AgentBoardRunnerLive = Layer.effect(
  AgentBoardRunner,
  Effect.gen(function* () {
    const boards = yield* AgentBoardFileSystem;
    const workflowFile = yield* WorkflowFile;
    const engine = yield* OrchestrationEngineService;
    const snapshot = yield* ProjectionSnapshotQuery;
    const git = yield* GitWorkflowService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;

    const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
    const commandId = (tag: string) =>
      uuid.pipe(Effect.map((value) => CommandId.make(`server:agent-board:${tag}:${value}`)));

    // ponytail: one lock for every project. Ticks are IO-light and rare (one
    // per project per polling interval); split per root if that stops holding.
    const lock = yield* Semaphore.make(1);
    const projects = new Map<string, ProjectState>();
    const nudges = new Set<string>();

    const stateFor = (root: string): Effect.Effect<ProjectState> =>
      Effect.gen(function* () {
        const existing = projects.get(root);
        if (existing !== undefined) return existing;
        const created: ProjectState = {
          tracked: new Map(),
          workflow: yield* workflowFile.load(root),
        };
        projects.set(root, created);
        return created;
      });

    const rootOfTrackedThread = (threadId: ThreadId): string | undefined => {
      for (const [root, state] of projects) {
        for (const tracked of state.tracked.values()) {
          if (tracked.threadId === threadId) return root;
        }
      }
      return undefined;
    };

    // ---- board helpers -----------------------------------------------------

    const saveCard = (
      root: string,
      cardId: AgentBoardCardId,
      patch: (card: AgentBoardCard, now: string) => AgentBoardCard,
    ) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        const { board } = yield* boards.load({ cwd: root });
        const next = patchCard(board, cardId, (card) => patch(card, now), now);
        return (yield* boards.save({ cwd: root, board: next })).board;
      });

    const needsDecision = (
      state: ProjectState,
      root: string,
      cardId: AgentBoardCardId,
      question: string,
      summary?: string,
    ) =>
      saveCard(root, cardId, (card, now) =>
        transition(
          card,
          {
            kind: "needs-decision",
            question: text(question, "Runner needs a decision."),
            ...(summary === undefined ? {} : { summary: text(summary, "no summary") }),
          },
          now,
        ),
      ).pipe(
        Effect.tap(() => Effect.sync(() => state.tracked.delete(cardId))),
        Effect.asVoid,
      );

    const retryLater = (
      state: ProjectState,
      root: string,
      cardId: AgentBoardCardId,
      error: string,
    ) =>
      Effect.gen(function* () {
        const { board } = yield* boards.load({ cwd: root });
        const card = board.cards.find((candidate) => candidate.id === cardId);
        if (card === undefined) {
          state.tracked.delete(cardId);
          return;
        }
        const maxRepairCycles = state.workflow.config.agent.maxRepairCycles;
        if (card.runtime.attemptCount > maxRepairCycles) {
          return yield* needsDecision(
            state,
            root,
            cardId,
            `Failed ${card.runtime.attemptCount} times (max_repair_cycles=${maxRepairCycles}). Last error: ${error}`,
          );
        }
        const nextRetryAt = DateTime.formatIso(
          DateTime.addDuration(
            yield* DateTime.now,
            Duration.millis(
              retryDelayMs(
                card.runtime.attemptCount,
                state.workflow.config.agent.maxRetryBackoffMs,
              ),
            ),
          ),
        );
        // `transition` owns the attemptCount bump so backoff keeps growing
        // across continuations, which `claim` alone would never see.
        yield* saveCard(root, cardId, (candidate, now) =>
          transition(
            candidate,
            { kind: "retry-later", error: text(error, "unknown failure"), nextRetryAt },
            now,
          ),
        );
        state.tracked.delete(cardId);
      });

    /** Any unexpected failure parks the card with backoff instead of dropping it. */
    const orRetryLater =
      (state: ProjectState, root: string, cardId: AgentBoardCardId) =>
      <A, E, R>(self: Effect.Effect<A, E, R>) =>
        catchNonInterrupt(self, (cause) => retryLater(state, root, cardId, Cause.pretty(cause)));

    // ---- orchestration commands -------------------------------------------

    const stopThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: yield* commandId("interrupt"),
          threadId,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.stop",
          commandId: yield* commandId("stop"),
          threadId,
          createdAt,
        });
      }).pipe(Effect.ignoreCause({ log: true }));

    const deleteThread = (threadId: ThreadId) =>
      commandId("delete").pipe(
        Effect.flatMap((id) => engine.dispatch({ type: "thread.delete", commandId: id, threadId })),
        Effect.ignoreCause({ log: true }),
      );

    const createThread = (input: {
      readonly project: OrchestrationProject;
      readonly modelSelection: ModelSelection;
      readonly title: string;
      readonly worktreePath: string;
      readonly branch: string | null;
    }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(yield* uuid);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: yield* commandId("create"),
          threadId,
          projectId: input.project.id,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: input.branch,
          worktreePath: input.worktreePath,
          createdAt: yield* nowIso,
        });
        return threadId;
      });

    const startTurn = (input: {
      readonly threadId: ThreadId;
      readonly modelSelection: ModelSelection;
      readonly prompt: string;
      readonly titleSeed: string;
    }) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("turn"),
          threadId: input.threadId,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection: input.modelSelection,
          titleSeed: input.titleSeed,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        });
      });

    /**
     * The project row plus its default model, or `undefined` when the project
     * is genuinely absent or has no model. A *failed* query is left in the
     * error channel on purpose: callers wrap this in `orRetryLater`, so a flaky
     * read backs off instead of parking the card on a false "no model".
     */
    const projectContext = (root: string) =>
      snapshot.getActiveProjectByWorkspaceRoot(root).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.map((project) =>
          project === undefined || project.defaultModelSelection === null
            ? undefined
            : { project, modelSelection: project.defaultModelSelection },
        ),
      );

    const NO_MODEL =
      "Set a default model for this project before running board cards, then move the card back to Ready.";

    // ---- launch ------------------------------------------------------------

    /**
     * `.t3/workspaces` holds card worktrees; without this the project root
     * shows every card's checkout as untracked noise.
     */
    const ensureExcluded = (root: string) =>
      Effect.gen(function* () {
        const file = path.join(root, ".git", "info", "exclude");
        const current = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
        if (current.split("\n").includes(".t3/workspaces/")) return;
        yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
        yield* fileSystem.writeFileString(
          file,
          `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}.t3/workspaces/\n`,
        );
      }).pipe(Effect.ignoreCause({ log: true }));

    const launch = (state: ProjectState, root: string, cardId: AgentBoardCardId) =>
      Effect.gen(function* () {
        const context = yield* projectContext(root);
        if (context === undefined) {
          // Checked before claiming: a missing model is a config problem, not
          // a failed attempt, and must not burn the retry budget.
          return yield* needsDecision(state, root, cardId, NO_MODEL);
        }
        const claimed = yield* boards.claim({ cwd: root, cardId });
        const workspacePath = path.join(root, claimed.workspacePath);
        yield* ensureExcluded(root);

        // Derived from the claimed workspace so the branch and the worktree
        // directory can never disagree about how a card id was sanitised.
        const branchName =
          claimed.card.runtime.branchName ?? `agent-board/${path.basename(claimed.workspacePath)}`;
        const reused = yield* fileSystem
          .exists(path.join(workspacePath, ".git"))
          .pipe(Effect.orElseSucceed(() => false));
        const branch = reused
          ? branchName
          : (yield* git.createWorktree({
              cwd: root,
              refName: "HEAD",
              newRefName: branchName,
              path: workspacePath,
            })).worktree.refName;

        const title = implementationThreadTitle(claimed.card);
        const threadId = yield* createThread({
          project: context.project,
          modelSelection: context.modelSelection,
          title,
          worktreePath: workspacePath,
          branch,
        });
        yield* startTurn({
          threadId,
          modelSelection: context.modelSelection,
          prompt: buildImplementationPrompt(claimed.card),
          titleSeed: title,
        }).pipe(Effect.tapCause(() => deleteThread(threadId)));
        // Recorded only after the turn is accepted, so a Running card always
        // carries the thread that owns it.
        yield* saveCard(root, cardId, (card, now) =>
          transition(
            card,
            { kind: "launched", threadId: RuntimeSessionId.make(threadId), branchName: branch },
            now,
          ),
        );
        state.tracked.set(cardId, { threadId, role: "implementation" });
      }).pipe(orRetryLater(state, root, cardId));

    // ---- continue / review -------------------------------------------------

    const continueCard = (
      state: ProjectState,
      root: string,
      card: AgentBoardCard,
      reason: ContinuationReason,
    ) =>
      Effect.gen(function* () {
        const context = yield* projectContext(root);
        const runId = card.runtime.implementationRunId;
        if (context === undefined || runId === undefined) {
          return yield* needsDecision(
            state,
            root,
            card.id,
            context === undefined
              ? NO_MODEL
              : "Cannot continue: no implementation thread is recorded. Move the card back to Ready to relaunch.",
          );
        }
        const maxTurns = state.workflow.config.agent.maxTurns;
        if (card.runtime.turnCount >= maxTurns) {
          return yield* needsDecision(
            state,
            root,
            card.id,
            `Reached max_turns=${maxTurns} without a done result. What should change?`,
          );
        }
        const threadId = ThreadId.make(runId);
        yield* startTurn({
          threadId,
          modelSelection: context.modelSelection,
          prompt: buildContinuationPrompt(card, reason),
          titleSeed: implementationThreadTitle(card),
        });
        yield* saveCard(root, card.id, (candidate, now) =>
          transition(candidate, { kind: "continued" }, now),
        );
        state.tracked.set(card.id, { threadId, role: "implementation" });
      }).pipe(orRetryLater(state, root, card.id));

    const startReview = (
      state: ProjectState,
      root: string,
      card: AgentBoardCard,
      summary: string,
    ) =>
      Effect.gen(function* () {
        const agent = state.workflow.config.agent;
        if (agent.reviewAgent === "none") {
          yield* saveCard(root, card.id, (candidate, now) =>
            transition(candidate, { kind: "success", state: agent.onSuccess, summary }, now),
          );
          state.tracked.delete(card.id);
          return;
        }
        const context = yield* projectContext(root);
        if (context === undefined || card.runtime.workspacePath === undefined) {
          return yield* needsDecision(
            state,
            root,
            card.id,
            context === undefined ? NO_MODEL : "Cannot start review: the card has no workspace.",
          );
        }
        // A fresh thread, never the implementation one: the reviewer must not
        // inherit the implementer's context.
        const title = reviewThreadTitle(card);
        const threadId = yield* createThread({
          project: context.project,
          modelSelection: context.modelSelection,
          title,
          worktreePath: path.join(root, card.runtime.workspacePath),
          branch: card.runtime.branchName ?? null,
        });
        yield* startTurn({
          threadId,
          modelSelection: context.modelSelection,
          prompt: buildReviewPrompt(card, summary),
          titleSeed: title,
        }).pipe(Effect.tapCause(() => deleteThread(threadId)));
        yield* saveCard(root, card.id, (candidate, now) =>
          transition(
            candidate,
            { kind: "review-started", threadId: RuntimeSessionId.make(threadId) },
            now,
          ),
        );
        state.tracked.set(card.id, { threadId, role: "review" });
      }).pipe(orRetryLater(state, root, card.id));

    /**
     * A review turn that ended with no result block is nudged to produce one.
     * Repeats on every result-less settle; `max_turns` is the only bound.
     */
    const nudgeReview = (state: ProjectState, root: string, card: AgentBoardCard) =>
      Effect.gen(function* () {
        const context = yield* projectContext(root);
        const runId = card.runtime.reviewRunId;
        if (
          context === undefined ||
          runId === undefined ||
          card.runtime.turnCount >= state.workflow.config.agent.maxTurns
        ) {
          return yield* needsDecision(
            state,
            root,
            card.id,
            "The review agent ended without a result block and cannot be retried.",
          );
        }
        yield* startTurn({
          threadId: ThreadId.make(runId),
          modelSelection: context.modelSelection,
          prompt:
            "Your last message had no agent-board-result block. Finish the review and end with exactly one block.",
          titleSeed: reviewThreadTitle(card),
        });
        yield* saveCard(root, card.id, (candidate, now) =>
          transition(
            candidate,
            { kind: "review-started", threadId: RuntimeSessionId.make(runId) },
            now,
          ),
        );
      }).pipe(orRetryLater(state, root, card.id));

    // ---- turn completion ---------------------------------------------------

    const lastAssistantText = (threadId: ThreadId) =>
      snapshot.getThreadDetailById(threadId).pipe(
        Effect.map((thread) =>
          Option.getOrElse(
            Option.map(
              thread,
              (detail) =>
                detail.messages
                  .toReversed()
                  .find((message) => message.role === "assistant" && message.streaming !== true)
                  ?.text ?? "",
            ),
            () => "",
          ),
        ),
        Effect.orElseSucceed(() => ""),
      );

    const onReviewSettled = (
      state: ProjectState,
      root: string,
      card: AgentBoardCard,
      assistantText: string,
    ) =>
      Effect.gen(function* () {
        const parsed = parseReviewResult(assistantText);
        if (Option.isNone(parsed)) return yield* nudgeReview(state, root, card);
        const result = parsed.value;
        if (result.outcome === "approved") {
          yield* saveCard(root, card.id, (candidate, now) =>
            transition(
              candidate,
              {
                kind: "success",
                state: state.workflow.config.agent.onSuccess,
                summary: result.summary,
              },
              now,
            ),
          );
          state.tracked.delete(card.id);
          return;
        }
        if (result.outcome === "needs-decision") {
          return yield* needsDecision(
            state,
            root,
            card.id,
            result.question ?? result.summary,
            result.summary,
          );
        }
        const findings = result.findings ?? [];
        const maxRepairCycles = state.workflow.config.agent.maxRepairCycles;
        if (card.runtime.repairCycleCount + 1 > maxRepairCycles) {
          return yield* needsDecision(
            state,
            root,
            card.id,
            `Review still requests changes after ${maxRepairCycles} repair cycles: ${findings.join("; ")}`,
            result.summary,
          );
        }
        const repaired = yield* saveCard(root, card.id, (candidate, now) =>
          transition(candidate, { kind: "repair", findings }, now),
        );
        const repairedCard = repaired.cards.find((candidate) => candidate.id === card.id);
        if (repairedCard === undefined) return;
        yield* continueCard(state, root, repairedCard, { kind: "review-findings", findings });
      });

    const onWorkerSettled = (
      state: ProjectState,
      root: string,
      card: AgentBoardCard,
      assistantText: string,
    ) =>
      Effect.gen(function* () {
        const parsed = parseWorkerResult(assistantText);
        if (Option.isNone(parsed) || parsed.value.outcome === "continue") {
          return yield* continueCard(state, root, card, { kind: "continue" });
        }
        const result = parsed.value;
        if (result.outcome === "needs-decision") {
          return yield* needsDecision(
            state,
            root,
            card.id,
            result.question ?? result.summary,
            result.summary,
          );
        }
        if (result.outcome === "blocked") {
          yield* saveCard(root, card.id, (candidate, now) =>
            transition(candidate, { kind: "blocked", error: result.summary }, now),
          );
          state.tracked.delete(card.id);
          return;
        }
        yield* startReview(state, root, card, result.summary);
      });

    const onTurnSettled = (
      state: ProjectState,
      root: string,
      card: AgentBoardCard,
      tracked: Tracked,
      session: OrchestrationSession,
    ) =>
      Effect.gen(function* () {
        if (session.status !== "ready") {
          return yield* retryLater(
            state,
            root,
            card.id,
            session.lastError ?? `Provider session ${session.status}`,
          );
        }
        const assistantText = yield* lastAssistantText(tracked.threadId);
        yield* tracked.role === "review"
          ? onReviewSettled(state, root, card, assistantText)
          : onWorkerSettled(state, root, card, assistantText);
      });

    // ---- tick --------------------------------------------------------------

    const tickUnlocked = (root: string, state: ProjectState) =>
      Effect.gen(function* () {
        state.workflow = yield* workflowFile.load(root);
        // Stamped before the early return: a root with no board file has still
        // been ticked, and `pollAll` would otherwise treat it as due forever.
        // Stamped before the early return: a root with no board file has still
        // been ticked, and `pollAll` would otherwise treat it as due forever.
        state.lastTickMillis = yield* Clock.currentTimeMillis;
        const loaded = yield* boards.load({ cwd: root }).pipe(Effect.option);
        if (Option.isNone(loaded)) return;
        const now = yield* nowIso;
        state.lastTickAt = now;
        let board = loaded.value.board;

        if (!board.runner.enabled) {
          for (const [cardId, tracked] of state.tracked) {
            yield* stopThread(tracked.threadId);
            state.tracked.delete(cardId);
          }
          return;
        }

        // A card the user dragged out of a runner state loses its worker.
        // Deleting the entry the loop is currently on is well-defined for Map.
        for (const [cardId, tracked] of state.tracked) {
          const card = board.cards.find((candidate) => candidate.id === cardId);
          if (card === undefined || !RUNNER_OWNED_STATES.has(card.state)) {
            yield* stopThread(tracked.threadId);
            state.tracked.delete(cardId);
          }
        }

        // Adopt every live card (this is also restart recovery) and settle any
        // turn that has already finished.
        for (const card of board.cards) {
          // `Diagnosing` cards are parked on a backoff; the retry pass owns them.
          if (!RUNNER_OWNED_STATES.has(card.state) || card.state === "Diagnosing") continue;
          // State, not `phase`: it is the field the user (and the UI) edits.
          const role: Role = card.state === "Reviewing" ? "review" : "implementation";
          const runId =
            role === "review" ? card.runtime.reviewRunId : card.runtime.implementationRunId;
          if (runId === undefined) {
            yield* retryLater(state, root, card.id, "No worker thread recorded for this card");
            continue;
          }
          const threadId = ThreadId.make(runId);
          const tracked: Tracked = { threadId, role };
          state.tracked.set(card.id, tracked);

          // A failed read is transient; only a `None` means the thread is gone.
          // `undefined` is the retried case: `Option.none()` is never undefined.
          const lookup = yield* catchNonInterrupt(snapshot.getThreadShellById(threadId), (cause) =>
            retryLater(state, root, card.id, Cause.pretty(cause)).pipe(Effect.as(undefined)),
          );
          if (lookup === undefined) continue;
          const shell = Option.getOrUndefined(lookup);
          if (shell === undefined) {
            yield* needsDecision(state, root, card.id, `Worker thread ${runId} no longer exists.`);
            continue;
          }
          if (shell.hasPendingApprovals || shell.hasPendingUserInput) {
            yield* stopThread(threadId);
            yield* needsDecision(
              state,
              root,
              card.id,
              "The worker is waiting for an approval or user input. Answer it in Chat, then move the card back to Ready.",
            );
            continue;
          }
          const session = shell.session;
          if (
            session !== null &&
            session.activeTurnId === null &&
            SETTLED_STATUSES.has(session.status)
          ) {
            yield* onTurnSettled(state, root, card, tracked, session);
          }
        }

        board = (yield* boards.load({ cwd: root })).board;

        for (const card of board.cards) {
          if (card.state !== "Diagnosing" || state.tracked.has(card.id)) continue;
          if (card.runtime.nextRetryAt !== undefined && card.runtime.nextRetryAt > now) continue;
          // A card that failed before its thread existed has nothing to
          // continue; re-launch it (plan §8) instead of parking it.
          if (card.runtime.implementationRunId === undefined) {
            yield* launch(state, root, card.id);
            continue;
          }
          const findings = card.runtime.reviewFindings;
          yield* continueCard(
            state,
            root,
            card,
            card.runtime.currentError === undefined && findings.length > 0
              ? { kind: "review-findings", findings }
              : { kind: "failed", error: card.runtime.currentError ?? "unknown failure" },
          );
        }

        board = (yield* boards.load({ cwd: root })).board;

        for (const card of selectClaimableCards(board, state.workflow.config)) {
          yield* launch(state, root, card.id);
        }

        if (state.tracked.size > 0) {
          const fresh = (yield* boards.load({ cwd: root })).board;
          const beat = yield* nowIso;
          yield* boards.save({
            cwd: root,
            board: {
              ...fresh,
              cards: fresh.cards.map((card) =>
                state.tracked.has(card.id)
                  ? (Object.assign({}, card, {
                      runtime: { ...card.runtime, lastHeartbeatAt: beat },
                    }) as AgentBoardCard)
                  : card,
              ),
              updatedAt: beat,
            },
          });
        }
      });

    const tickSafely = (root: string, state: ProjectState) =>
      catchNonInterrupt(tickUnlocked(root, state), (cause) =>
        Effect.logWarning("agent board tick failed", { root, cause: Cause.pretty(cause) }),
      );

    const tick = (root: string): Effect.Effect<void> =>
      lock.withPermits(1)(stateFor(root).pipe(Effect.flatMap((state) => tickSafely(root, state))));

    // ---- scheduler ---------------------------------------------------------

    const onEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
      if (event.type !== "thread.session-set") return Effect.void;
      const { threadId, session } = event.payload;
      if (session.activeTurnId !== null || !SETTLED_STATUSES.has(session.status)) {
        return Effect.void;
      }
      const root = rootOfTrackedThread(threadId);
      return root === undefined ? Effect.void : tick(root);
    };

    let lastDiscoveryAt = 0;
    const pollAll = Effect.gen(function* () {
      // Drained into `forced` so the polling-interval gate below cannot swallow
      // a nudge that lands right after a tick.
      const forced = new Set(nudges);
      nudges.clear();
      const roots = new Set<string>([...projects.keys(), ...forced]);
      // ponytail: the full read model is heavy; reading it once per discovery
      // interval (not once per second) keeps the cost off the hot path. Swap in
      // a projects-only query if this ever shows up in a profile.
      const millis = yield* Clock.currentTimeMillis;
      if (millis - lastDiscoveryAt >= DISCOVERY_INTERVAL_MS) {
        lastDiscoveryAt = millis;
        const model = yield* snapshot.getSnapshot().pipe(Effect.orElseSucceed(() => undefined));
        if (model !== undefined) {
          const discovered = new Set(
            model.projects
              .filter((project) => project.deletedAt === null)
              .map((project) => project.workspaceRoot),
          );
          for (const root of discovered) roots.add(root);
          // A root the project list no longer has, with nothing in flight, is
          // dropped so the poll set cannot grow forever. `nudge` and `tick`
          // both re-create state, so nothing that still matters stays evicted.
          for (const [root, state] of projects) {
            if (discovered.has(root) || state.tracked.size > 0 || forced.has(root)) continue;
            projects.delete(root);
            roots.delete(root);
          }
        }
      }
      for (const root of roots) {
        const state = yield* stateFor(root);
        const due =
          forced.has(root) ||
          state.lastTickMillis === undefined ||
          millis - state.lastTickMillis >= state.workflow.config.polling.intervalMs;
        if (due) yield* tick(root);
      }
    }).pipe(Effect.ignoreCause({ log: true }));

    const start = () =>
      Effect.gen(function* () {
        const worker = yield* makeDrainableWorker(onEvent);
        yield* forkParked(
          Stream.runForEach(engine.streamDomainEvents, (event) => worker.enqueue(event)),
        );
        // ponytail: one global 1 s sweep with per-project interval gating.
        // Fine for the dozens of projects a single server hosts.
        yield* forkParked(
          Effect.sleep(SCHEDULER_INTERVAL).pipe(Effect.andThen(pollAll), Effect.forever),
        );
      });

    // Read-scoped: never `stateFor`, or every status poll would enroll its root
    // in the polling set for the lifetime of the server.
    const status = (root: string): Effect.Effect<AgentBoardRunnerStatus> =>
      Effect.gen(function* () {
        const state = projects.get(root);
        const workflow = state?.workflow ?? (yield* workflowFile.load(root));
        const loaded = yield* boards.load({ cwd: root }).pipe(Effect.option);
        return {
          enabled: Option.isSome(loaded) ? loaded.value.board.runner.enabled : false,
          workflowSource: workflow.source,
          ...(workflow.error === undefined ? {} : { workflowError: workflow.error }),
          activeCardIds: state === undefined ? [] : [...state.tracked.keys()],
          ...(state?.lastTickAt === undefined ? {} : { lastTickAt: state.lastTickAt }),
        };
      });

    const nudge = (root: string) => Effect.sync(() => void nudges.add(root));

    return AgentBoardRunner.of({ start, tick, status, nudge });
  }),
);
