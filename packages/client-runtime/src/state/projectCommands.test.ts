import { describe, expect, it } from "@effect/vitest";
import {
  AgentBoardCardId,
  type AgentBoardFile,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createProjectEnvironmentAtoms } from "./projectCommands.ts";

const environmentId = EnvironmentId.make("environment-1");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const board: AgentBoardFile = {
  schemaVersion: 1,
  projectRoot: "/repo",
  defaultView: "kanban",
  runner: { enabled: false, maxConcurrentCards: 1, repairCycles: 3 },
  cards: [],
  graphLinks: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

type ProjectAtomRuntime = Atom.AtomRuntime<
  EnvironmentRegistry.EnvironmentRegistry | Crypto.Crypto,
  never
>;

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeProjectAtoms = Effect.fnUntraced(function* (client: WsRpcProtocolClient) {
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  // The board commands never touch `Crypto`; only the project create/update
  // commands in the same family do.
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  ) as unknown as ProjectAtomRuntime;
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { projects: createProjectEnvironmentAtoms(runtime), registry };
});

describe("createProjectEnvironmentAtoms agent board", () => {
  it("keys board queries by environment and project", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as ProjectAtomRuntime;
    const projects = createProjectEnvironmentAtoms(runtime);
    const atom = projects.loadAgentBoard({
      environmentId,
      input: { cwd: "/repo", createIfMissing: true },
    });

    expect(
      projects.loadAgentBoard({ environmentId, input: { cwd: "/repo", createIfMissing: true } }),
    ).toBe(atom);
    expect(projects.loadAgentBoard({ environmentId, input: { cwd: "/other" } })).not.toBe(atom);
    expect(
      projects.loadAgentBoard({
        environmentId: EnvironmentId.make("environment-2"),
        input: { cwd: "/repo", createIfMissing: true },
      }),
    ).not.toBe(atom);
  });

  it.effect("serializes board writes per project while leaving other projects free", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = Latch.makeUnsafe();
        const started: string[] = [];
        const startedOther = Latch.makeUnsafe();
        const inFlight = (cwd: string) =>
          Effect.suspend(() => {
            started.push(cwd);
            if (cwd === "/other") {
              startedOther.openUnsafe();
            }
            return gate.await;
          });
        const client = {
          [WS_METHODS.projectsSaveAgentBoard]: (input: { readonly cwd: string }) =>
            inFlight(input.cwd).pipe(
              Effect.as({ board, relativePath: ".t3/agent-board.json" as const }),
            ),
          [WS_METHODS.projectsClaimAgentBoardCard]: (input: { readonly cwd: string }) =>
            inFlight(input.cwd).pipe(
              Effect.as({
                board,
                card: board.cards[0],
                relativePath: ".t3/agent-board.json" as const,
                workspacePath: ".t3/workspaces/card-1",
              }),
            ),
          [WS_METHODS.projectsSetAgentBoardRunnerEnabled]: (input: { readonly cwd: string }) =>
            inFlight(input.cwd).pipe(
              Effect.as({ board, relativePath: ".t3/agent-board.json" as const }),
            ),
        } as unknown as WsRpcProtocolClient;
        const { projects, registry } = yield* makeProjectAtoms(client);

        const save = projects.saveAgentBoard.run(registry, {
          environmentId,
          input: { cwd: "/repo", board },
        });
        const claim = projects.claimAgentBoardCard.run(registry, {
          environmentId,
          input: { cwd: "/repo", cardId: AgentBoardCardId.make("card-1") },
        });
        const toggle = projects.setAgentBoardRunnerEnabled.run(registry, {
          environmentId,
          input: { cwd: "/repo", enabled: true },
        });
        const otherSave = projects.saveAgentBoard.run(registry, {
          environmentId,
          input: { cwd: "/other", board },
        });

        // The unrelated project starts immediately; the same project stays queued.
        yield* startedOther.await;
        expect(started.filter((cwd) => cwd === "/repo")).toEqual(["/repo"]);

        gate.openUnsafe();
        yield* Effect.promise(() => Promise.all([save, claim, toggle, otherSave]));

        expect(started.filter((cwd) => cwd === "/repo")).toEqual(["/repo", "/repo", "/repo"]);
      }),
    ),
  );
});
