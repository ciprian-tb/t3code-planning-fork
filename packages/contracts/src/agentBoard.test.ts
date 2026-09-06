import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentBoardFile, AgentBoardReviewResult, AgentBoardWorkerResult } from "./agentBoard.ts";

const NOW = "2026-08-30T00:00:00.000Z";

const decodeAgentBoardFile = Schema.decodeUnknownSync(AgentBoardFile);
const decodeWorkerResult = Schema.decodeUnknownSync(AgentBoardWorkerResult);
const decodeReviewResult = Schema.decodeUnknownSync(AgentBoardReviewResult);

// The two Ready-card fixtures differ by exactly one key, so the pass/throw pair
// below isolates the "Ready requires an intent brief" rule from every other check.
const seededReadyCardWithoutBrief = {
  id: "TASK-20260505-agent-board-contract",
  title: "Define board file contract",
  state: "Ready",
  taskRecordPath: "docs/agents/tasks/TASK-20260505-agent-board-contract.md",
  slicePlanPath: "docs/agents/slices/authoritative-agent-board.md",
  graphPosition: { x: 640, y: 120 },
  parallelism: {
    safe: "conditional",
    reason: "Schema-only work can run beside UI planning.",
    allowedWriteScopes: ["packages/contracts/src/agentBoard.ts"],
  },
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const seededReadyCard = {
  ...seededReadyCardWithoutBrief,
  intentBrief: {
    intent: "Create the first durable schema for the project-local agent board file.",
    acceptanceCriteria: ["Board files decode through the shared contracts package."],
  },
};

const boardWithCard = (card: object) => ({
  projectRoot: "/repo",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  graphLinks: [{ from: "area:Backend", to: "area:Frontend" }],
  cards: [card],
});

describe("AgentBoardFile", () => {
  it("preserves a task model override and accepts old cards without one", () => {
    const modelSelection = { instanceId: "opencode", model: "mtplx/local", options: [] };
    const board = decodeAgentBoardFile(boardWithCard({ ...seededReadyCard, modelSelection }));
    expect(board.cards[0]?.modelSelection).toEqual(modelSelection);
    expect(
      decodeAgentBoardFile(boardWithCard(seededReadyCard)).cards[0]?.modelSelection,
    ).toBeUndefined();
    expect(() =>
      decodeAgentBoardFile(boardWithCard({ ...seededReadyCard, modelSelection: { model: "" } })),
    ).toThrow();
  });

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
    expect(board.runner).toEqual({ enabled: false, maxConcurrentCards: 1, repairCycles: 3 });
  });

  it("rejects a Ready card without an intent brief", () => {
    expect(() =>
      decodeAgentBoardFile({
        schemaVersion: 1,
        projectRoot: "/repo",
        cards: [
          {
            id: "CARD-1",
            title: "Ship",
            state: "Ready",
            priority: 1,
            createdAt: "2026-08-30T00:00:00.000Z",
            updatedAt: "2026-08-30T00:00:00.000Z",
          },
        ],
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("decodes a seeded board with runtime, graph, and parallelism metadata", () => {
    const board = decodeAgentBoardFile(boardWithCard(seededReadyCard));

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

  it("rejects that same seeded card once only its intent brief is removed", () => {
    expect(() => decodeAgentBoardFile(boardWithCard(seededReadyCardWithoutBrief))).toThrow();
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

  it("decodes a legacy card without runner fields to safe defaults", () => {
    const board = decodeAgentBoardFile({
      schemaVersion: 1,
      projectRoot: "/repo",
      cards: [{ id: "CARD-1", title: "Legacy", state: "Backlog", createdAt: NOW, updatedAt: NOW }],
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(board.runner.enabled).toBe(false);
    expect(board.cards[0]?.runtime.turnCount).toBe(0);
    expect(board.cards[0]?.runtime.repairCycleCount).toBe(0);
    expect(board.cards[0]?.runtime.reviewFindings).toEqual([]);
    expect(board.cards[0]?.runtime.phase).toBeUndefined();
  });
});

describe("AgentBoard result protocol", () => {
  it("requires a question for a needs-decision worker result", () => {
    expect(() => decodeWorkerResult({ outcome: "needs-decision", summary: "x" })).toThrow();
    expect(decodeWorkerResult({ outcome: "done", summary: "shipped" }).outcome).toBe("done");
  });

  it("requires findings for a changes-requested review result", () => {
    expect(() =>
      decodeReviewResult({
        outcome: "changes-requested",
        summary: "x",
      }),
    ).toThrow();
    expect(
      decodeReviewResult({
        outcome: "changes-requested",
        summary: "x",
        findings: ["missing test"],
      }).findings,
    ).toEqual(["missing test"]);
  });

  it("requires a question for a needs-decision review result", () => {
    expect(() => decodeReviewResult({ outcome: "needs-decision", summary: "x" })).toThrow();
  });
});
