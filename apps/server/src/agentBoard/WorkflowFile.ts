import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

import {
  AgentBoardWorkflowConfig,
  DEFAULT_AGENT_BOARD_WORKFLOW,
  type AgentBoardWorkflowSource,
} from "@t3tools/contracts";

export interface LoadedWorkflow {
  readonly config: AgentBoardWorkflowConfig;
  readonly source: AgentBoardWorkflowSource;
  readonly error?: string;
}

/**
 * Reads `WORKFLOW.md` from a project root and decodes its front matter into the
 * runner's workflow config. Loading never fails: a broken or missing file
 * degrades to the last config that parsed for that project, then to the
 * defaults, with the parse error reported alongside so the UI can surface it.
 */
export class WorkflowFile extends Context.Service<
  WorkflowFile,
  {
    readonly load: (projectRoot: string) => Effect.Effect<LoadedWorkflow>;
  }
>()("t3/agentBoard/WorkflowFile") {}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const decodeWorkflowConfig = Schema.decodeUnknownSync(AgentBoardWorkflowConfig);

/**
 * A file with no front matter block is a valid workflow that customises
 * nothing, so it yields the defaults rather than an error.
 */
export function parseWorkflowFrontMatter(
  contents: string,
): { readonly config: AgentBoardWorkflowConfig } | { readonly error: string } {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { config: DEFAULT_AGENT_BOARD_WORKFLOW };
  }

  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    return { config: decodeWorkflowConfig(parsed ?? {}) };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // ponytail: last-known-good is per project root and in memory only; a server
  // restart with a still-broken WORKFLOW.md falls back to the defaults.
  const lastKnownGood = new Map<string, AgentBoardWorkflowConfig>();

  const load = (projectRoot: string): Effect.Effect<LoadedWorkflow> =>
    Effect.gen(function* () {
      const contents = yield* fileSystem
        .readFileString(path.join(projectRoot, "WORKFLOW.md"))
        .pipe(Effect.option);
      if (Option.isNone(contents)) {
        return { config: DEFAULT_AGENT_BOARD_WORKFLOW, source: "defaults" as const };
      }

      const result = parseWorkflowFrontMatter(contents.value);
      if ("config" in result) {
        lastKnownGood.set(projectRoot, result.config);
        return { config: result.config, source: "workflow-md" as const };
      }

      const previous = lastKnownGood.get(projectRoot);
      return previous
        ? { config: previous, source: "last-known-good" as const, error: result.error }
        : {
            config: DEFAULT_AGENT_BOARD_WORKFLOW,
            source: "defaults" as const,
            error: result.error,
          };
    });

  return WorkflowFile.of({ load });
});

export const WorkflowFileLive = Layer.effect(WorkflowFile, make);
