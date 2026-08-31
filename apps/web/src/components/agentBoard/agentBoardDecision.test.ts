import type { AgentBoardCard, AgentBoardCardId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { answerDecision } from "./agentBoardDecision";

const NOW = "2026-08-30T00:00:00.000Z";
const EARLIER = "2026-08-29T00:00:00.000Z";

function decisionCard(overrides: Partial<AgentBoardCard> = {}): AgentBoardCard {
  return {
    id: "CARD-1" as AgentBoardCardId,
    title: "Pick a database",
    state: "Needs Decision",
    priority: 3,
    dependencies: [],
    parallelism: { safe: "false", conflictsWith: [], allowedWriteScopes: [] },
    runtime: {
      attemptCount: 2,
      turnCount: 3,
      repairCycleCount: 1,
      reviewFindings: ["missing index"],
      phase: "implementing",
      nextRetryAt: EARLIER,
      currentError: "turn failed",
      currentDecisionQuestion: "Postgres or SQLite?",
    },
    intentBrief: {
      intent: "db",
      acceptanceCriteria: ["it stores rows"],
      constraints: ["no ORM"],
      nonGoals: [],
      openDecisions: ["Postgres or SQLite?"],
    },
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  } as AgentBoardCard;
}

describe("answerDecision", () => {
  it("records the answer as a constraint and returns the card to Ready", () => {
    const card = decisionCard();
    const next = answerDecision(card, "  SQLite  ", NOW);

    expect(next.state).toBe("Ready");
    expect(next.intentBrief?.constraints).toEqual(["no ORM", "Postgres or SQLite? → SQLite"]);
    expect(next.updatedAt).toBe(NOW);
    // The source card is untouched: the panel adopts the returned board only
    // after the save round-trips.
    expect(card.state).toBe("Needs Decision");
    expect(card.intentBrief?.constraints).toEqual(["no ORM"]);
  });

  it("clears the fields that would make the runner think the card is still stuck", () => {
    const next = answerDecision(decisionCard(), "SQLite", NOW);

    expect(next.runtime.currentDecisionQuestion).toBeUndefined();
    expect(next.runtime.currentError).toBeUndefined();
    expect(next.runtime.nextRetryAt).toBeUndefined();
    expect(next.runtime.phase).toBeUndefined();
    // Counters are history, not blockers, so answering must not reset them.
    expect(next.runtime.attemptCount).toBe(2);
    expect(next.runtime.turnCount).toBe(3);
    expect(next.runtime.repairCycleCount).toBe(1);
  });

  it("falls back to Draft when the card has no intent brief", () => {
    const { intentBrief: _brief, ...withoutBrief } = decisionCard();
    const next = answerDecision(withoutBrief as AgentBoardCard, "SQLite", NOW);

    expect(next.state).toBe("Draft");
    expect("intentBrief" in next).toBe(false);
  });

  it("labels the constraint generically when the runner never asked a question", () => {
    const card = decisionCard({
      runtime: { attemptCount: 0, turnCount: 0, repairCycleCount: 0, reviewFindings: [] },
    });

    expect(answerDecision(card, "SQLite", NOW).intentBrief?.constraints).toEqual([
      "no ORM",
      "Decision → SQLite",
    ]);
  });
});
