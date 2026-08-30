import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

const intRange = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

/**
 * `WORKFLOW.md` YAML front matter, exactly as an author writes it: Symphony's
 * snake_case keys. Every key is optional — an empty front matter block is a
 * valid workflow — and unknown keys (Symphony's `hooks`, `codex`, …) are
 * dropped by struct decoding rather than rejected, so a workflow file shared
 * with Symphony still loads here.
 *
 * The literal-pinned fields (`tracker`, `workspace`) exist to *reject* a file
 * written for another tracker or workspace strategy; there is nothing to carry
 * into the runtime config, so they are validated and dropped.
 */
export const AgentBoardWorkflowFrontMatter = Schema.Struct({
  tracker: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.optionalKey(Schema.Literal("t3-local")),
      board_file: Schema.optionalKey(Schema.Literal(".t3/agent-board.json")),
    }),
  ),
  polling: Schema.optionalKey(
    Schema.Struct({
      interval_ms: Schema.optionalKey(intRange(1_000, 600_000)),
    }),
  ),
  workspace: Schema.optionalKey(
    Schema.Struct({
      root: Schema.optionalKey(Schema.Literal(".t3/workspaces")),
      strategy: Schema.optionalKey(Schema.Literal("per-card")),
    }),
  ),
  agent: Schema.optionalKey(
    Schema.Struct({
      max_concurrent_agents: Schema.optionalKey(intRange(1, 8)),
      max_turns: Schema.optionalKey(intRange(1, 200)),
      max_retry_backoff_ms: Schema.optionalKey(intRange(1_000, 3_600_000)),
      max_repair_cycles: Schema.optionalKey(intRange(0, 20)),
      review_agent: Schema.optionalKey(Schema.Literals(["fresh", "none"])),
      on_success: Schema.optionalKey(Schema.Literals(["Review", "Done"])),
    }),
  ),
});

const AgentBoardWorkflowRuntime = Schema.Struct({
  polling: Schema.Struct({ intervalMs: Schema.Number }),
  agent: Schema.Struct({
    maxConcurrentAgents: Schema.Number,
    maxTurns: Schema.Number,
    maxRetryBackoffMs: Schema.Number,
    maxRepairCycles: Schema.Number,
    reviewAgent: Schema.Literals(["fresh", "none"]),
    onSuccess: Schema.Literals(["Review", "Done"]),
  }),
});

/**
 * Runtime workflow config consumed by the agent-board runner: camelCase, every
 * field present. Decoding fills the defaults, so `decode({})` is the default
 * workflow. Decode-only — the front matter file is the source of truth and is
 * never regenerated from the runtime shape.
 */
export const AgentBoardWorkflowConfig = AgentBoardWorkflowFrontMatter.pipe(
  Schema.decodeTo(
    AgentBoardWorkflowRuntime,
    // Generics are pinned because the decode-only `encode` returns `never`,
    // which would otherwise collapse the inferred source type.
    SchemaTransformation.transformOrFail<
      typeof AgentBoardWorkflowRuntime.Encoded,
      typeof AgentBoardWorkflowFrontMatter.Type
    >({
      decode: (frontMatter) =>
        Effect.succeed({
          polling: { intervalMs: frontMatter.polling?.interval_ms ?? 15_000 },
          agent: {
            maxConcurrentAgents: frontMatter.agent?.max_concurrent_agents ?? 1,
            maxTurns: frontMatter.agent?.max_turns ?? 20,
            maxRetryBackoffMs: frontMatter.agent?.max_retry_backoff_ms ?? 300_000,
            maxRepairCycles: frontMatter.agent?.max_repair_cycles ?? 3,
            reviewAgent: frontMatter.agent?.review_agent ?? "fresh",
            onSuccess: frontMatter.agent?.on_success ?? "Review",
          },
        } satisfies typeof AgentBoardWorkflowRuntime.Encoded),
      encode: () => Effect.die("AgentBoardWorkflowConfig is decode-only"),
    }),
  ),
);
export type AgentBoardWorkflowConfig = typeof AgentBoardWorkflowConfig.Type;

export const DEFAULT_AGENT_BOARD_WORKFLOW: AgentBoardWorkflowConfig = Schema.decodeUnknownSync(
  AgentBoardWorkflowConfig,
)({});

/** Where a loaded workflow config came from — surfaced so the UI can warn. */
export const AgentBoardWorkflowSource = Schema.Literals([
  "workflow-md",
  "last-known-good",
  "defaults",
]);
export type AgentBoardWorkflowSource = typeof AgentBoardWorkflowSource.Type;
