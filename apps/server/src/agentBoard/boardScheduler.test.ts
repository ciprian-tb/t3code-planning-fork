import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_AGENT_BOARD_WORKFLOW,
  type AgentBoardCard,
  type AgentBoardCardId,
  type AgentBoardFile,
  type RuntimeSessionId,
} from "@t3tools/contracts";

import { patchCard, retryDelayMs, selectClaimableCards, transition } from "./boardScheduler.ts";

const NOW = "2026-08-30T00:00:00.000Z";
const id = (value: string) => value as AgentBoardCardId;
const runId = (value: string) => value as RuntimeSessionId;
const brief = {
  intent: "x",
  acceptanceCriteria: ["y"],
  constraints: [],
  nonGoals: [],
  openDecisions: [],
};
const SAFE = { safe: "true" as const, conflictsWith: [], allowedWriteScopes: [] };

const mk = (over: Partial<AgentBoardCard> & { id: string }): AgentBoardCard =>
  ({
    title: over.id,
    state: "Ready",
    priority: 3,
    dependencies: [],
    parallelism: { safe: "false", conflictsWith: [], allowedWriteScopes: [] },
    runtime: { attemptCount: 0, turnCount: 0, repairCycleCount: 0, reviewFindings: [] },
    intentBrief: brief,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as AgentBoardCard;

const board = (cards: AgentBoardCard[]): AgentBoardFile =>
  ({
    schemaVersion: 1,
    projectRoot: "/r",
    defaultView: "kanban",
    runner: { enabled: true, maxConcurrentCards: 1, repairCycles: 3 },
    cards,
    graphLinks: [],
    createdAt: NOW,
    updatedAt: NOW,
  }) as AgentBoardFile;

const cfg = DEFAULT_AGENT_BOARD_WORKFLOW;
const cfg2 = { ...cfg, agent: { ...cfg.agent, maxConcurrentAgents: 2 } };

describe("selectClaimableCards", () => {
  it("orders by priority, createdAt, id and respects the free slots", () => {
    const b = board([
      mk({ id: id("B"), priority: 1, createdAt: "2026-08-30T00:00:01.000Z", parallelism: SAFE }),
      mk({ id: id("A"), priority: 1, parallelism: SAFE }),
      mk({ id: id("C"), priority: 2, parallelism: SAFE }),
    ]);
    expect(selectClaimableCards(b, cfg).map((c) => c.id)).toEqual(["A"]);
    expect(selectClaimableCards(b, cfg2).map((c) => c.id)).toEqual(["A", "B"]);
  });

  it("takes only the first card when the candidates are not parallel-safe", () => {
    const b = board([mk({ id: id("A"), priority: 1 }), mk({ id: id("B"), priority: 1 })]);
    expect(selectClaimableCards(b, cfg2).map((c) => c.id)).toEqual(["A"]);
  });

  it("blocks on incomplete or unknown dependencies", () => {
    // `DEP` is Draft, so it consumes no slot and both candidates are
    // parallel-safe: the dependency gate is the only thing that can reject them.
    const blocked = [
      mk({ id: id("DEP"), state: "Draft" }),
      mk({ id: id("A"), dependencies: [id("DEP")], parallelism: SAFE }),
      mk({ id: id("B"), dependencies: [id("GHOST")], parallelism: SAFE }),
    ];
    expect(selectClaimableCards(board(blocked), cfg2).map((c) => c.id)).toEqual([]);

    const done = board(
      blocked.map((c) => (c.id === "DEP" ? mk({ id: id("DEP"), state: "Done" }) : c)),
    );
    // Only `A` unblocks; `B` still points at an id no card has.
    expect(selectClaimableCards(done, cfg2).map((c) => c.id)).toEqual(["A"]);
  });

  it("skips Ready cards without an intent brief", () => {
    const { intentBrief: _dropped, ...noBrief } = mk({ id: id("A") });
    const b = board([noBrief as AgentBoardCard]);
    expect(selectClaimableCards(b, cfg)).toEqual([]);
  });

  it("never exceeds concurrency counting Running/Diagnosing/Reviewing", () => {
    const b = board([mk({ id: id("R"), state: "Diagnosing" }), mk({ id: id("A") })]);
    expect(selectClaimableCards(b, cfg)).toEqual([]);
  });

  it("parallel launch requires safe=true on all sides and no conflicts", () => {
    const running = mk({ id: id("R"), state: "Running", parallelism: SAFE });
    expect(selectClaimableCards(board([running, mk({ id: id("A") })]), cfg2)).toEqual([]);
    expect(
      selectClaimableCards(board([running, mk({ id: id("A"), parallelism: SAFE })]), cfg2).map(
        (c) => c.id,
      ),
    ).toEqual(["A"]);
    expect(
      selectClaimableCards(
        board([running, mk({ id: id("A"), parallelism: { ...SAFE, conflictsWith: [id("R")] } })]),
        cfg2,
      ),
    ).toEqual([]);
    const unsafeRunning = mk({ id: id("R"), state: "Running" });
    expect(
      selectClaimableCards(board([unsafeRunning, mk({ id: id("A"), parallelism: SAFE })]), cfg2),
    ).toEqual([]);
  });
});

describe("retryDelayMs", () => {
  it("doubles from 1s and caps", () => {
    expect(retryDelayMs(1, 300_000)).toBe(1000);
    expect(retryDelayMs(3, 300_000)).toBe(4000);
    expect(retryDelayMs(30, 300_000)).toBe(300_000);
  });
});

describe("transition", () => {
  it("clears error fields on launch and sets phase", () => {
    const card = mk({
      id: id("A"),
      state: "Running",
      runtime: {
        attemptCount: 1,
        turnCount: 0,
        repairCycleCount: 0,
        reviewFindings: [],
        currentError: "old",
      },
    });
    const next = transition(
      card,
      { kind: "launched", threadId: runId("t1"), branchName: "agent-board/A" },
      NOW,
    );
    expect(next.state).toBe("Running");
    expect(next.runtime.phase).toBe("implementing");
    expect(next.runtime.turnCount).toBe(1);
    expect(next.runtime.currentError).toBeUndefined();
    expect(next.runtime.implementationRunId).toBe("t1");
    expect(next.runtime.branchName).toBe("agent-board/A");
    expect(next.runtime.lastHeartbeatAt).toBe(NOW);
  });

  it("continued and review-started bump the turn count", () => {
    const running = transition(mk({ id: id("A"), state: "Running" }), { kind: "continued" }, NOW);
    expect(running.state).toBe("Running");
    expect(running.runtime.turnCount).toBe(1);
    const reviewing = transition(running, { kind: "review-started", threadId: runId("t2") }, NOW);
    expect(reviewing.state).toBe("Reviewing");
    expect(reviewing.runtime.phase).toBe("reviewing");
    expect(reviewing.runtime.reviewRunId).toBe("t2");
    expect(reviewing.runtime.turnCount).toBe(2);
  });

  it("repair increments repairCycleCount and stores findings", () => {
    const next = transition(
      mk({ id: id("A"), state: "Reviewing" }),
      { kind: "repair", findings: ["f1"] },
      NOW,
    );
    expect(next.state).toBe("Diagnosing");
    expect(next.runtime.phase).toBe("repairing");
    expect(next.runtime.repairCycleCount).toBe(1);
    expect(next.runtime.reviewFindings).toEqual(["f1"]);
  });

  it("retry-later records the error, the retry time and a new attempt", () => {
    const card = mk({
      id: id("A"),
      state: "Running",
      runtime: { attemptCount: 1, turnCount: 2, repairCycleCount: 0, reviewFindings: [] },
    });
    const retryAt = "2026-08-30T00:00:05.000Z";
    const next = transition(
      card,
      { kind: "retry-later", error: "boom", nextRetryAt: retryAt },
      NOW,
    );
    expect(next.state).toBe("Diagnosing");
    expect(next.runtime.phase).toBe("repairing");
    expect(next.runtime.currentError).toBe("boom");
    expect(next.runtime.nextRetryAt).toBe(retryAt);
    expect(next.runtime.attemptCount).toBe(2);
  });

  it("success clears findings and records the summary", () => {
    const card = mk({
      id: id("A"),
      state: "Reviewing",
      runtime: { attemptCount: 1, turnCount: 1, repairCycleCount: 1, reviewFindings: ["f1"] },
    });
    const next = transition(card, { kind: "success", state: "Review", summary: "ok" }, NOW);
    expect(next.state).toBe("Review");
    expect(next.runtime.reviewFindings).toEqual([]);
    expect(next.runtime.lastResultSummary).toBe("ok");
    expect(next.runtime.phase).toBeUndefined();
  });

  it("needs-decision drops the intent-brief requirement and keeps the question", () => {
    const next = transition(
      mk({ id: id("A"), state: "Running" }),
      { kind: "needs-decision", question: "Which DB?" },
      NOW,
    );
    expect(next.state).toBe("Needs Decision");
    expect(next.runtime.currentDecisionQuestion).toBe("Which DB?");
    expect(next.runtime.phase).toBeUndefined();
    expect(next.runtime.nextRetryAt).toBeUndefined();
  });

  it("blocked records the error and clears the phase", () => {
    const card = mk({
      id: id("A"),
      state: "Running",
      runtime: {
        attemptCount: 1,
        turnCount: 1,
        repairCycleCount: 0,
        reviewFindings: [],
        phase: "implementing",
      },
    });
    const next = transition(card, { kind: "blocked", error: "no credentials" }, NOW);
    expect(next.state).toBe("Blocked");
    expect(next.runtime.currentError).toBe("no credentials");
    expect(next.runtime.phase).toBeUndefined();
  });
});

describe("patchCard", () => {
  it("replaces one card immutably and bumps timestamps", () => {
    const before = board([mk({ id: id("A") }), mk({ id: id("B") })]);
    const later = "2026-08-30T01:00:00.000Z";
    const after = patchCard(
      before,
      id("A"),
      (c) => transition(c, { kind: "continued" }, later),
      later,
    );
    expect(after).not.toBe(before);
    expect(before.cards[0]?.runtime.turnCount).toBe(0);
    expect(after.updatedAt).toBe(later);
    const patched = after.cards.find((c) => c.id === "A");
    expect(patched?.state).toBe("Running");
    expect(patched?.updatedAt).toBe(later);
    expect(patched?.runtime.lastHeartbeatAt).toBe(later);
    expect(after.cards.find((c) => c.id === "B")).toBe(before.cards[1]);
  });
});
