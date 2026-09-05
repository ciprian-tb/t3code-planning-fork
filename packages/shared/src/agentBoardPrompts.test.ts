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

  it("drops every task-record instruction when the card has no task record", () => {
    const { taskRecordPath: _dropped, ...noRecord } = card as unknown as Record<string, unknown>;
    const uiCard = noRecord as unknown as AgentBoardCard;

    const prompts = [
      buildImplementationPrompt(uiCard),
      buildContinuationPrompt(uiCard, { kind: "continue" }),
      buildReviewPrompt(uiCard, "implemented login"),
    ];
    for (const prompt of prompts) {
      expect(prompt).not.toContain("task record");
      expect(prompt).not.toContain("Task record");
    }
    // The verification requirement survives; only its source changes.
    expect(prompts[0]).toContain("focused verification");
    expect(prompts[1]).toContain("focused verification");
    expect(prompts[2]).toContain("focused verification");

    // With a task record, every one of those lines is back.
    expect(buildImplementationPrompt(card)).toContain("named in the task record");
    expect(buildImplementationPrompt(card)).toContain("task record's proof section");
    expect(buildContinuationPrompt(card, { kind: "continue" })).toContain("task record proof");
    expect(buildReviewPrompt(card, "implemented login")).toContain(
      "Task record: docs/agents/tasks/TASK-1.md",
    );
    expect(buildReviewPrompt(card, "implemented login")).toContain("named in the task record");
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

  // Observed in the integrated pass: a reviewer emitted `"question":""` three
  // turns running. Every optional string is a `TrimmedNonEmptyString`, so the
  // blank made the whole block undecodable, the runner reported "no block", and
  // the card burned turns re-prompting an agent that had already answered.
  it("reads a blank optional string as an absent field", () => {
    const review = parseReviewResult(
      '```agent-board-result\n{"outcome":"approved","summary":"verified","findings":[],"question":""}\n```',
    );
    expect(Option.isSome(review)).toBe(true);
    expect(Option.getOrThrow(review).question).toBeUndefined();

    const worker = parseWorkerResult(
      '```agent-board-result\n{"outcome":"done","summary":"shipped","question":"   "}\n```',
    );
    expect(Option.isSome(worker)).toBe(true);
    expect(Option.getOrThrow(worker).question).toBeUndefined();
  });

  it("still rejects a blank value the outcome makes mandatory", () => {
    // `needs-decision` requires a question; dropping the blank must not smuggle
    // one past the check, it must leave the block invalid.
    expect(
      Option.isNone(
        parseWorkerResult(
          '```agent-board-result\n{"outcome":"needs-decision","summary":"x","question":""}\n```',
        ),
      ),
    ).toBe(true);
  });

  it("keeps a non-blank optional string", () => {
    const worker = parseWorkerResult(
      '```agent-board-result\n{"outcome":"needs-decision","summary":"x","question":"A or B?"}\n```',
    );
    expect(Option.getOrThrow(worker).question).toBe("A or B?");
  });
});
