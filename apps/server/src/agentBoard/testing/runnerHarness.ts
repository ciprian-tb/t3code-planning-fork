/**
 * runnerHarness - in-memory doubles for the services `AgentBoardRunner` drives.
 *
 * The runner only ever observes the orchestration world through three services,
 * so the harness fakes exactly those: an engine that records commands and keeps
 * a thread map, a projection query that reads that map, and a git service that
 * pretends every worktree creation succeeds. `finishTurn` publishes the real
 * `thread.session-set` payload shape so the runner's completion path is
 * exercised against the contract, not a convenient approximation.
 *
 * ponytail: threads are cast into their contract shapes; only the fields the
 * runner reads are real. Widen them the day a test needs more.
 *
 * @module runnerHarness
 */
import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  EventId,
  MessageId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

export interface Harness {
  readonly commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly threads: Ref.Ref<Map<ThreadId, OrchestrationThread>>;
  readonly project: OrchestrationProject;
  /** Simulate a provider turn finishing with the given assistant text (or an error). */
  readonly finishTurn: (
    threadId: ThreadId,
    result: { readonly text: string } | { readonly error: string },
  ) => Effect.Effect<void>;
  readonly layer: Layer.Layer<
    OrchestrationEngineService | ProjectionSnapshotQuery | GitWorkflowService
  >;
}

const ACTIVE_TURN = TurnId.make("turn");

export const makeHarness = (project: OrchestrationProject): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const threads = yield* Ref.make(new Map<ThreadId, OrchestrationThread>());
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const sequence = yield* Ref.make(0);

    const session = (
      threadId: ThreadId,
      status: OrchestrationSessionStatus,
      lastError: string | null,
      activeTurnId: TurnId | null,
      now: string,
    ): OrchestrationSession => ({
      threadId,
      status,
      providerName: "fake",
      runtimeMode: "full-access",
      activeTurnId,
      lastError,
      updatedAt: now,
    });

    const engine = OrchestrationEngineService.of({
      readEvents: () => Stream.empty,
      latestSequence: Ref.get(sequence),
      streamDomainEvents: Stream.fromPubSub(events),
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(commands, (recorded) => [...recorded, command]);
          const now = DateTime.formatIso(yield* DateTime.now);
          if (command.type === "thread.create") {
            yield* Ref.update(threads, (map) =>
              new Map(map).set(command.threadId, {
                id: command.threadId,
                projectId: command.projectId,
                title: command.title,
                modelSelection: command.modelSelection,
                runtimeMode: command.runtimeMode,
                interactionMode: command.interactionMode,
                branch: command.branch,
                worktreePath: command.worktreePath,
                latestTurn: null,
                deletedAt: null,
                messages: [],
                proposedPlans: [],
                activities: [],
                checkpoints: [],
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                session: session(command.threadId, "idle", null, null, now),
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              } satisfies OrchestrationThread),
            );
          }
          if (command.type === "thread.turn.start") {
            yield* Ref.update(threads, (map) => {
              const thread = map.get(command.threadId);
              if (thread === undefined) return map;
              return new Map(map).set(command.threadId, {
                ...thread,
                messages: [
                  ...thread.messages,
                  {
                    id: command.message.messageId,
                    role: "user",
                    text: command.message.text,
                    turnId: null,
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
                session: session(command.threadId, "running", null, ACTIVE_TURN, now),
              } as unknown as OrchestrationThread);
            });
          }
          if (command.type === "thread.delete") {
            yield* Ref.update(threads, (map) => {
              const next = new Map(map);
              next.delete(command.threadId);
              return next;
            });
          }
          return { sequence: yield* Ref.updateAndGet(sequence, (value) => value + 1) };
        }),
    });

    const shellOf = (thread: OrchestrationThread): OrchestrationThreadShell =>
      ({
        ...thread,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      }) as unknown as OrchestrationThreadShell;

    const snapshot = ProjectionSnapshotQuery.of({
      getSnapshot: () =>
        Ref.get(threads).pipe(
          Effect.map(
            (map) =>
              ({
                snapshotSequence: 0,
                projects: [project],
                threads: [...map.values()],
                updatedAt: project.updatedAt,
              }) as never,
          ),
        ),
      getActiveProjectByWorkspaceRoot: (workspaceRoot: string) =>
        Effect.succeed(
          workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
        ),
      getThreadShellById: (threadId: ThreadId) =>
        Ref.get(threads).pipe(
          Effect.map((map) => Option.map(Option.fromNullishOr(map.get(threadId)), shellOf)),
        ),
      getThreadDetailById: (threadId: ThreadId) =>
        Ref.get(threads).pipe(Effect.map((map) => Option.fromNullishOr(map.get(threadId)))),
    } as never);

    const git = GitWorkflowService.of({
      createWorktree: (input: {
        readonly newRefName?: string | undefined;
        readonly path: string | null;
      }) =>
        Effect.succeed({
          worktree: { path: input.path ?? "/tmp/worktree", refName: input.newRefName ?? "HEAD" },
        }),
    } as never);

    const finishTurn: Harness["finishTurn"] = (threadId, result) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const failed = "error" in result;
        yield* Ref.update(threads, (map) => {
          const thread = map.get(threadId);
          if (thread === undefined) return map;
          return new Map(map).set(threadId, {
            ...thread,
            messages: failed
              ? thread.messages
              : [
                  ...thread.messages,
                  {
                    id: MessageId.make(`assistant-${thread.messages.length}`),
                    role: "assistant",
                    text: result.text,
                    turnId: null,
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
            session: session(
              threadId,
              failed ? "error" : "ready",
              failed ? result.error : null,
              null,
              now,
            ),
          } as unknown as OrchestrationThread);
        });
        const thread = (yield* Ref.get(threads)).get(threadId);
        if (thread === undefined || thread.session === null) return;
        const next = yield* Ref.updateAndGet(sequence, (value) => value + 1);
        yield* PubSub.publish(events, {
          sequence: next,
          eventId: EventId.make(`event-${next}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.session-set",
          payload: { threadId, session: thread.session },
        });
      });

    return {
      commands,
      threads,
      project,
      finishTurn,
      layer: Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, engine),
        Layer.succeed(ProjectionSnapshotQuery, snapshot),
        Layer.succeed(GitWorkflowService, git),
      ),
    } satisfies Harness;
  });
