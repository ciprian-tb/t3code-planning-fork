import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentBoardFile } from "./agentBoard.ts";

const decodeAgentBoardFile = Schema.decodeUnknownSync(AgentBoardFile);

describe("AgentBoardFile", () => {
  it("defaults a minimal board to kanban with no cards", () => {
    const board = decodeAgentBoardFile({
      schemaVersion: 1,
      projectRoot: "/repo",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    });

    expect(board.defaultView).toBe("kanban");
    expect(board.cards).toEqual([]);
    expect(board.graphLinks).toEqual([]);
    expect(board.runner).toEqual({ maxConcurrentCards: 1, repairCycles: 3 });
  });

  it("rejects a Ready card without an intent brief", () => {
    expect(() =>
      decodeAgentBoardFile({
        schemaVersion: 1,
        projectRoot: "/repo",
        cards: [{ id: "CARD-1", title: "Ship", state: "Ready", priority: "high" }],
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("decodes a seeded board with runtime, graph, and parallelism metadata", () => {
    const board = decodeAgentBoardFile({
      projectRoot: "/repo",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      graphLinks: [{ from: "area:Backend", to: "area:Frontend" }],
      cards: [
        {
          id: "TASK-20260505-agent-board-contract",
          title: "Define board file contract",
          state: "Ready",
          taskRecordPath: "docs/agents/tasks/TASK-20260505-agent-board-contract.md",
          slicePlanPath: "docs/agents/slices/authoritative-agent-board.md",
          graphPosition: { x: 640, y: 120 },
          intentBrief: {
            intent: "Create the first durable schema for the project-local agent board file.",
            acceptanceCriteria: ["Board files decode through the shared contracts package."],
          },
          parallelism: {
            safe: "conditional",
            reason: "Schema-only work can run beside UI planning.",
            allowedWriteScopes: ["packages/contracts/src/agentBoard.ts"],
          },
          createdAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    });

    expect(board.schemaVersion).toBe(1);
    expect(board.cards[0]?.state).toBe("Ready");
    expect(board.cards[0]?.priority).toBe(3);
    expect(board.cards[0]?.dependencies).toEqual([]);
    expect(board.cards[0]?.runtime.attemptCount).toBe(0);
    expect(board.cards[0]?.parallelism.allowedWriteScopes).toEqual([
      "packages/contracts/src/agentBoard.ts",
    ]);
    expect(board.cards[0]?.graphPosition).toEqual({ x: 640, y: 120 });
    expect(board.graphLinks).toEqual([
      { from: "area:Backend", to: "area:Frontend", kind: "depends-on" },
    ]);
  });

  it("decodes a non-Ready card without an intent brief", () => {
    const board = decodeAgentBoardFile({
      projectRoot: "/repo",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      cards: [
        {
          id: "CARD-1",
          title: "Draft it",
          state: "Draft",
          createdAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    });

    expect(board.cards[0]?.state).toBe("Draft");
    expect(board.cards[0]?.intentBrief).toBeUndefined();
  });
});
