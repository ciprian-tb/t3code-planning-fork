import { describe, expect, it } from "vite-plus/test";
import { Option } from "effect";
import type { AgentBoardCard } from "@t3tools/contracts";
import {
  buildContinuationPrompt,
  buildImplementationPrompt,
  buildReviewPrompt,
  implementationThreadTitle,
  parseReviewResult,
  parseWorkerResult,
  reviewThreadTitle,
} from "./agentBoardPrompts.ts";

const card = {
  id: "CARD-1",
  title: "Add login",
  state: "Ready",
  priority: 2,
  taskRecordPath: "docs/agents/tasks/TASK-1.md",
  slicePlanPath: "docs/agents/slices/auth.md",
  dependencies: [],
  parallelism: { safe: "false", conflictsWith: [], allowedWriteScopes: ["apps/web/src/auth/**"] },
  runtime: {
    attemptCount: 1,
    turnCount: 0,
    repairCycleCount: 0,
    reviewFindings: [],
    workspacePath: ".t3/workspaces/CARD-1",
  },
  intentBrief: {
    intent: "Users can log in",
    acceptanceCriteria: ["login form submits"],
    constraints: [],
    nonGoals: ["SSO"],
    openDecisions: [],
  },
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
} as unknown as AgentBoardCard;

describe("prompts", () => {
  it("implementation prompt carries scope, references, and the result protocol", () => {
    const prompt = buildImplementationPrompt(card);
    for (const needle of [
      "CARD-1",
      "docs/agents/tasks/TASK-1.md",
      "apps/web/src/auth/**",
      "AGENTS.md",
      "WORKFLOW.md",
      "```agent-board-result",
      "needs-decision",
    ]) {
      expect(prompt).toContain(needle);
    }
  });

  it("continuation prompt is short and names the reason", () => {
    const prompt = buildContinuationPrompt(card, {
      kind: "review-findings",
      findings: ["missing test"],
    });
    expect(prompt).toContain("missing test");
    expect(prompt).not.toContain("Users can log in");
    expect(prompt.length).toBeLessThan(buildImplementationPrompt(card).length);
  });

  it("review prompt insists on a fresh perspective and the review protocol", () => {
    const prompt = buildReviewPrompt(card, "implemented login");
    expect(prompt).toContain("fresh review agent");
    expect(prompt).toContain("changes-requested");
    expect(prompt).toContain("implemented login");
  });

  it("thread titles name the card", () => {
    expect(implementationThreadTitle(card)).toBe("Implement Add login");
    expect(reviewThreadTitle(card)).toBe("Review Add login");
  });
});

describe("parsers", () => {
  it("parses the last agent-board-result block", () => {
    const text = [
      "first",
      "```agent-board-result",
      '{"outcome":"continue","summary":"half"}',
      "```",
      "more work",
      "```agent-board-result",
      '{"outcome":"done","summary":"finished","changedFiles":["a.ts"]}',
      "```",
    ].join("\n");
    const result = parseWorkerResult(text);
    expect(Option.isSome(result)).toBe(true);
    expect(Option.getOrThrow(result).outcome).toBe("done");
  });

  it("returns none for missing, malformed, or invalid blocks", () => {
    expect(Option.isNone(parseWorkerResult("no block"))).toBe(true);
    expect(Option.isNone(parseWorkerResult("```agent-board-result\n{bad\n```"))).toBe(true);
    expect(
      Option.isNone(
        parseWorkerResult('```agent-board-result\n{"outcome":"needs-decision","summary":"x"}\n```'),
      ),
    ).toBe(true);
    expect(
      Option.isSome(
        parseReviewResult('```agent-board-result\n{"outcome":"approved","summary":"ok"}\n```'),
      ),
    ).toBe(true);
  });
});
