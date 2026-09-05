import { type EnvironmentId, type ProjectReadFileResult, WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import {
  type CreateProjectInput,
  type DeleteProjectInput,
  type UpdateProjectInput,
  createProject,
  deleteProject,
  updateProject,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  // Project commands identify a project by id, board commands by its checkout
  // path; either way one project's writes run one at a time.
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { projectId: string } | { cwd: string };
    }) => JSON.stringify([environmentId, "projectId" in input ? input.projectId : input.cwd]),
  };
  return {
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    readFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file",
      tag: WS_METHODS.projectsReadFile,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    loadAgentBoard: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:load-agent-board",
      tag: WS_METHODS.projectsLoadAgentBoard,
      staleTimeMs: 5_000,
      // The runner moves cards on its own, so the board polls like the runner
      // status does; without it the Kanban sits still until a manual refresh.
      refreshIntervalMs: 5_000,
      idleTtlMs: 5 * 60_000,
    }),
    getAgentBoardRunnerStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:agent-board-runner-status",
      tag: WS_METHODS.projectsGetAgentBoardRunnerStatus,
      staleTimeMs: 2_000,
      // The runner ticks on its own, so the status line has to poll to stay
      // honest. Only mounted atoms refresh, so this costs nothing off Planning.
      refreshIntervalMs: 5_000,
      idleTtlMs: 60_000,
    }),
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
    saveAgentBoard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:save-agent-board",
      tag: WS_METHODS.projectsSaveAgentBoard,
      scheduler: fileScheduler,
      concurrency: projectConcurrency,
    }),
    claimAgentBoardCard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:claim-agent-board-card",
      tag: WS_METHODS.projectsClaimAgentBoardCard,
      scheduler: fileScheduler,
      concurrency: projectConcurrency,
    }),
    setAgentBoardRunnerEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:set-agent-board-runner-enabled",
      tag: WS_METHODS.projectsSetAgentBoardRunnerEnabled,
      scheduler: fileScheduler,
      concurrency: projectConcurrency,
    }),
  };
}
