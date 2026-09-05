import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AgentBoardWorkflowSource } from "./agentBoardWorkflow.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RuntimeSessionId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Relative location of the project-local planning board inside a workspace. */
export const AGENT_BOARD_RELATIVE_PATH = ".t3/agent-board.json";

export const AgentBoardSchemaVersion = Schema.Literal(1);
export type AgentBoardSchemaVersion = typeof AgentBoardSchemaVersion.Type;

export const AgentBoardCardId = TrimmedNonEmptyString.pipe(Schema.brand("AgentBoardCardId"));
export type AgentBoardCardId = typeof AgentBoardCardId.Type;

export const AgentBoardState = Schema.Literals([
  "Backlog",
  "Draft",
  "Ready",
  "Running",
  "Diagnosing",
  "Reviewing",
  "Review",
  "Done",
  "Blocked",
  "Needs Decision",
  "Canceled",
]);
export type AgentBoardState = typeof AgentBoardState.Type;

/** Every state except `Ready`; `Ready` cards carry a mandatory intent brief. */
export const AgentBoardNonReadyState = Schema.Literals([
  "Backlog",
  "Draft",
  "Running",
  "Diagnosing",
  "Reviewing",
  "Review",
  "Done",
  "Blocked",
  "Needs Decision",
  "Canceled",
]);
export type AgentBoardNonReadyState = typeof AgentBoardNonReadyState.Type;

export const AgentBoardView = Schema.Literals(["kanban", "table", "execution-path"]);
export type AgentBoardView = typeof AgentBoardView.Type;

export const AgentBoardParallelismSafety = Schema.Literals(["false", "true", "conditional"]);
export type AgentBoardParallelismSafety = typeof AgentBoardParallelismSafety.Type;

export const AgentBoardIntentBrief = Schema.Struct({
  intent: TrimmedNonEmptyString,
  desiredOutcome: Schema.optionalKey(TrimmedNonEmptyString),
  acceptanceCriteria: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  constraints: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  nonGoals: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  openDecisions: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type AgentBoardIntentBrief = typeof AgentBoardIntentBrief.Type;

export const AgentBoardParallelismPlan = Schema.Struct({
  safe: AgentBoardParallelismSafety.pipe(
    Schema.withDecodingDefault(Effect.succeed("false" as const)),
  ),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
  conflictsWith: Schema.Array(AgentBoardCardId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  allowedWriteScopes: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type AgentBoardParallelismPlan = typeof AgentBoardParallelismPlan.Type;

/** Which agent leg a claimed card is currently in; absent while idle. */
// `manual`: a human ran the card from the UI and owns it; the runner never
// adopts, continues or stops a manual card.
export const AgentBoardRuntimePhase = Schema.Literals([
  "implementing",
  "repairing",
  "reviewing",
  "manual",
]);
export type AgentBoardRuntimePhase = typeof AgentBoardRuntimePhase.Type;

export const AgentBoardRuntime = Schema.Struct({
  workspacePath: Schema.optionalKey(TrimmedNonEmptyString),
  branchName: Schema.optionalKey(TrimmedNonEmptyString),
  implementationRunId: Schema.optionalKey(RuntimeSessionId),
  reviewRunId: Schema.optionalKey(RuntimeSessionId),
  attemptCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  turnCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  repairCycleCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  phase: Schema.optionalKey(AgentBoardRuntimePhase),
  nextRetryAt: Schema.optionalKey(IsoDateTime),
  lastHeartbeatAt: Schema.optionalKey(IsoDateTime),
  lastResultSummary: Schema.optionalKey(TrimmedNonEmptyString),
  reviewFindings: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  currentError: Schema.optionalKey(TrimmedNonEmptyString),
  currentDecisionQuestion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AgentBoardRuntime = typeof AgentBoardRuntime.Type;

export const AgentBoardGraphPosition = Schema.Struct({
  x: NonNegativeInt,
  y: NonNegativeInt,
});
export type AgentBoardGraphPosition = typeof AgentBoardGraphPosition.Type;

export const AgentBoardGraphLinkKind = Schema.Literals(["depends-on", "connects-to"]);
export type AgentBoardGraphLinkKind = typeof AgentBoardGraphLinkKind.Type;

export const AgentBoardGraphLink = Schema.Struct({
  from: TrimmedNonEmptyString,
  to: TrimmedNonEmptyString,
  kind: AgentBoardGraphLinkKind.pipe(
    Schema.withDecodingDefault(Effect.succeed("depends-on" as const)),
  ),
});
export type AgentBoardGraphLink = typeof AgentBoardGraphLink.Type;

const AgentBoardCardBaseFields = {
  id: AgentBoardCardId,
  title: TrimmedNonEmptyString,
  priority: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(3))),
  area: Schema.optionalKey(TrimmedNonEmptyString),
  slice: Schema.optionalKey(TrimmedNonEmptyString),
  taskRecordPath: Schema.optionalKey(TrimmedNonEmptyString),
  slicePlanPath: Schema.optionalKey(TrimmedNonEmptyString),
  graphPosition: Schema.optionalKey(AgentBoardGraphPosition),
  dependencies: Schema.Array(AgentBoardCardId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  parallelism: AgentBoardParallelismPlan.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        safe: "false" as const,
        conflictsWith: [],
        allowedWriteScopes: [],
      }),
    ),
  ),
  runtime: AgentBoardRuntime.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        attemptCount: 0,
        turnCount: 0,
        repairCycleCount: 0,
        reviewFindings: [],
      }),
    ),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
} as const;

export const AgentBoardReadyCard = Schema.Struct({
  ...AgentBoardCardBaseFields,
  state: Schema.Literal("Ready"),
  intentBrief: AgentBoardIntentBrief,
});
export type AgentBoardReadyCard = typeof AgentBoardReadyCard.Type;

export const AgentBoardNonReadyCard = Schema.Struct({
  ...AgentBoardCardBaseFields,
  state: AgentBoardNonReadyState,
  intentBrief: Schema.optionalKey(AgentBoardIntentBrief),
});
export type AgentBoardNonReadyCard = typeof AgentBoardNonReadyCard.Type;

export const AgentBoardCard = Schema.Union([AgentBoardReadyCard, AgentBoardNonReadyCard]);
export type AgentBoardCard = typeof AgentBoardCard.Type;

export const AgentBoardRunnerSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  maxConcurrentCards: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  repairCycles: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(3))),
});
export type AgentBoardRunnerSettings = typeof AgentBoardRunnerSettings.Type;

export const AgentBoardFile = Schema.Struct({
  schemaVersion: AgentBoardSchemaVersion.pipe(
    Schema.withDecodingDefault(Effect.succeed(1 as const)),
  ),
  projectRoot: TrimmedNonEmptyString,
  defaultView: AgentBoardView.pipe(Schema.withDecodingDefault(Effect.succeed("kanban" as const))),
  runner: AgentBoardRunnerSettings.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        enabled: false,
        maxConcurrentCards: 1,
        repairCycles: 3,
      }),
    ),
  ),
  cards: Schema.Array(AgentBoardCard).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  graphLinks: Schema.Array(AgentBoardGraphLink).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentBoardFile = typeof AgentBoardFile.Type;

export const AgentBoardLoadInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  createIfMissing: Schema.optionalKey(Schema.Boolean),
});
export type AgentBoardLoadInput = typeof AgentBoardLoadInput.Type;

export const AgentBoardLoadResult = Schema.Struct({
  board: AgentBoardFile,
  relativePath: Schema.Literal(AGENT_BOARD_RELATIVE_PATH),
  created: Schema.Boolean,
});
export type AgentBoardLoadResult = typeof AgentBoardLoadResult.Type;

export const AgentBoardSaveInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  board: AgentBoardFile,
  /**
   * Optimistic concurrency: the `updatedAt` of the board this save was derived
   * from. When set and the on-disk board has moved past it, the save is
   * refused so a stale whole-board snapshot cannot revert the runner's
   * transitions on other cards.
   */
  expectedUpdatedAt: Schema.optionalKey(IsoDateTime),
});
export type AgentBoardSaveInput = typeof AgentBoardSaveInput.Type;

export const AgentBoardSaveResult = Schema.Struct({
  board: AgentBoardFile,
  relativePath: Schema.Literal(AGENT_BOARD_RELATIVE_PATH),
});
export type AgentBoardSaveResult = typeof AgentBoardSaveResult.Type;

export const AgentBoardClaimInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  cardId: AgentBoardCardId,
});
export type AgentBoardClaimInput = typeof AgentBoardClaimInput.Type;

export const AgentBoardClaimResult = Schema.Struct({
  board: AgentBoardFile,
  card: AgentBoardCard,
  relativePath: Schema.Literal(AGENT_BOARD_RELATIVE_PATH),
  workspacePath: TrimmedNonEmptyString,
});
export type AgentBoardClaimResult = typeof AgentBoardClaimResult.Type;

export class AgentBoardFileError extends Schema.TaggedErrorClass<AgentBoardFileError>()(
  "AgentBoardFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * What a worker turn reports back. `question` is mandatory for
 * `needs-decision` — a card cannot land in `Needs Decision` with nothing to
 * ask the human.
 */
export const AgentBoardWorkerResult = Schema.Struct({
  outcome: Schema.Literals(["done", "continue", "needs-decision", "blocked"]),
  summary: TrimmedNonEmptyString,
  question: Schema.optionalKey(TrimmedNonEmptyString),
  changedFiles: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
}).check(
  Schema.makeFilter(
    (result) =>
      result.outcome !== "needs-decision" ||
      result.question !== undefined ||
      "question is required when outcome is needs-decision",
  ),
);
export type AgentBoardWorkerResult = typeof AgentBoardWorkerResult.Type;

/** Same contract for the review leg: no empty rejections, no silent questions. */
export const AgentBoardReviewResult = Schema.Struct({
  outcome: Schema.Literals(["approved", "changes-requested", "needs-decision"]),
  summary: TrimmedNonEmptyString,
  findings: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  question: Schema.optionalKey(TrimmedNonEmptyString),
})
  .check(
    Schema.makeFilter(
      (result) =>
        result.outcome !== "changes-requested" ||
        result.findings !== undefined ||
        "findings is required when outcome is changes-requested",
    ),
  )
  .check(
    Schema.makeFilter(
      (result) =>
        result.outcome !== "needs-decision" ||
        result.question !== undefined ||
        "question is required when outcome is needs-decision",
    ),
  );
export type AgentBoardReviewResult = typeof AgentBoardReviewResult.Type;

export const AgentBoardRunnerStatus = Schema.Struct({
  enabled: Schema.Boolean,
  workflowSource: AgentBoardWorkflowSource,
  workflowError: Schema.optionalKey(TrimmedNonEmptyString),
  activeCardIds: Schema.Array(AgentBoardCardId),
  lastTickAt: Schema.optionalKey(IsoDateTime),
});
export type AgentBoardRunnerStatus = typeof AgentBoardRunnerStatus.Type;

export const AgentBoardRunnerStatusInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type AgentBoardRunnerStatusInput = typeof AgentBoardRunnerStatusInput.Type;

export const AgentBoardSetRunnerEnabledInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type AgentBoardSetRunnerEnabledInput = typeof AgentBoardSetRunnerEnabledInput.Type;
