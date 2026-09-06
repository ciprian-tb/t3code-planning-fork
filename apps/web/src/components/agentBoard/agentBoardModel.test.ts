import type { AgentBoardCard, AgentBoardCardId, AgentBoardFile } from "@t3tools/contracts";
import { RuntimeSessionId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_COLUMNS,
  buildExecutionTree,
  cardRuntimeSummary,
  cardWithDetailDraft,
  cardWithLaunchedRun,
  cardWithLaunchFailure,
  cardWithPlanningField,
  cardWithState,
  detailDraftFromCard,
  groupDependencyTreeCards,
  intentBriefFromDraft,
  intentDraftFromCard,
  intentSaveError,
  isBoardConflictError,
  newCardForState,
  runCardError,
  runnerStatusLine,
  sortCardsForTable,
  stateBadgeVariant,
  updateCard,
} from "./agentBoardModel";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function card(id: string, overrides: Partial<AgentBoardCard> = {}): AgentBoardCard {
  return {
    id: id as AgentBoardCardId,
    title: `Card ${id}`,
    state: "Draft",
    priority: 3,
    dependencies: [],
    parallelism: { safe: "false", conflictsWith: [], allowedWriteScopes: [] },
    runtime: { attemptCount: 0, turnCount: 0, repairCycleCount: 0, reviewFindings: [] },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  } as AgentBoardCard;
}

function board(cards: readonly AgentBoardCard[]): AgentBoardFile {
  return {
    schemaVersion: 1,
    projectRoot: "/repo",
    defaultView: "kanban",
    runner: { enabled: false, maxConcurrentCards: 1, repairCycles: 3 },
    cards,
    graphLinks: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function boardWithCycle(first: string, second: string): AgentBoardFile {
  return board([
    card(first, { area: "Core", dependencies: [second as AgentBoardCardId] }),
    card(second, { area: "Core", dependencies: [first as AgentBoardCardId] }),
  ]);
}

describe("BOARD_COLUMNS", () => {
  // Mirrors `RUNNER_OWNED_STATES` in `apps/server/src/agentBoard/boardScheduler.ts`
  // (server-only module, so the list is restated rather than imported).
  it("gives every runner-owned state a column so a card cannot vanish mid-run", () => {
    const columnStates = BOARD_COLUMNS.map((column) => column.state);
    for (const state of ["Running", "Diagnosing", "Reviewing"] as const) {
      expect(columnStates).toContain(state);
    }
  });

  it("orders the run states the way the runner walks them", () => {
    const columnStates = BOARD_COLUMNS.map((column) => column.state);
    expect(columnStates.indexOf("Running")).toBeLessThan(columnStates.indexOf("Reviewing"));
    expect(columnStates.indexOf("Reviewing")).toBeLessThan(columnStates.indexOf("Review"));
  });
});

describe("updateCard", () => {
  it("updates structured dependencies without mutating the source board", () => {
    const source = board([card("CARD-1"), card("CARD-2")]);
    const next = updateCard(source, "CARD-2" as AgentBoardCardId, (existing) => ({
      ...existing,
      dependencies: ["CARD-1" as AgentBoardCardId],
    }));
    expect(source.cards[1]?.dependencies).toEqual([]);
    expect(next.cards[1]?.dependencies).toEqual(["CARD-1"]);
  });

  it("stamps updatedAt on the card and the board", () => {
    const source = board([card("CARD-1")]);
    const next = updateCard(
      source,
      "CARD-1" as AgentBoardCardId,
      (existing) => existing,
      "2026-02-02T00:00:00.000Z",
    );
    expect(next.cards[0]?.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(next.updatedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  // The card dialog builds its draft from a pre-edit card, so the draft carries
  // the old `updatedAt`. Stamping before the updater would let that value ride
  // straight back onto the board and make the card look untouched.
  it("stamps after the updater, so an updater cannot return a stale updatedAt", () => {
    const source = board([card("CARD-1")]);
    const next = updateCard(
      source,
      "CARD-1" as AgentBoardCardId,
      (existing) => ({ ...existing, updatedAt: TIMESTAMP }) as AgentBoardCard,
      "2026-02-02T00:00:00.000Z",
    );
    expect(next.cards[0]?.updatedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("returns the same board when the card is unknown", () => {
    const source = board([card("CARD-1")]);
    expect(updateCard(source, "MISSING" as AgentBoardCardId, (existing) => existing)).toBe(source);
  });
});

describe("cardWithState", () => {
  it("gives a card promoted to Ready a mandatory intent brief", () => {
    const moved = cardWithState(card("CARD-1"), "Ready", TIMESTAMP);
    expect(moved.state).toBe("Ready");
    expect(moved.intentBrief?.intent).toBe("Card CARD-1");
  });

  it("keeps an existing intent brief when moving states", () => {
    const source = card("CARD-1", {
      intentBrief: {
        intent: "Ship it",
        acceptanceCriteria: [],
        constraints: [],
        nonGoals: [],
        openDecisions: [],
      },
    });
    expect(cardWithState(source, "Ready", TIMESTAMP).intentBrief?.intent).toBe("Ship it");
  });
});

describe("cardWithPlanningField", () => {
  it("drops the key when the value is blank", () => {
    const source = card("CARD-1", { area: "Core" });
    expect("area" in cardWithPlanningField(source, "area", "   ")).toBe(false);
  });

  it("trims the value when set", () => {
    expect(cardWithPlanningField(card("CARD-1"), "slice", "  Checkout ").slice).toBe("Checkout");
  });
});

describe("intent brief drafts", () => {
  it("round-trips list fields through newline text", () => {
    const draft = intentDraftFromCard(
      card("CARD-1", {
        intentBrief: {
          intent: "Do the thing",
          desiredOutcome: "Tested",
          acceptanceCriteria: ["A", "B"],
          constraints: [],
          nonGoals: [],
          openDecisions: [],
        },
      }),
    );
    expect(draft.acceptanceCriteria).toBe("A\nB");
    expect(intentBriefFromDraft(draft)?.acceptanceCriteria).toEqual(["A", "B"]);
  });

  it("returns null when intent is empty", () => {
    expect(intentBriefFromDraft(intentDraftFromCard(card("CARD-1")))).toBeNull();
  });

  it("exposes dependencies as newline text in the detail draft", () => {
    const draft = detailDraftFromCard(
      card("CARD-1", { dependencies: ["A", "B"] as AgentBoardCardId[] }),
    );
    expect(draft.dependencies).toBe("A\nB");
  });
});

describe("cardWithDetailDraft", () => {
  const source = card("CARD-1", {
    area: "Core",
    slice: "Auth",
    slicePlanPath: "docs/plan.md",
    parallelism: { safe: "true", reason: "Isolated", conflictsWith: [], allowedWriteScopes: [] },
    intentBrief: {
      intent: "Ship it",
      acceptanceCriteria: [],
      constraints: [],
      nonGoals: [],
      openDecisions: [],
    },
  });

  it("drops optional keys the draft blanked out", () => {
    const next = cardWithDetailDraft(source, {
      ...detailDraftFromCard(source),
      area: "  ",
      slicePlanPath: "",
      parallelismReason: "   ",
    });
    expect("area" in next).toBe(false);
    expect("slicePlanPath" in next).toBe(false);
    expect("reason" in next.parallelism).toBe(false);
    expect(next.slice).toBe("Auth");
    expect(source.area).toBe("Core");
  });

  it("splits list fields, keeps the old title when blanked, and leaves the brief alone", () => {
    const next = cardWithDetailDraft(source, {
      ...detailDraftFromCard(source),
      title: "   ",
      dependencies: "CARD-2\n\n  CARD-3  ",
      allowedWriteScopes: "apps/web\napps/server",
    });
    expect(next.title).toBe(source.title);
    expect(next.dependencies).toEqual(["CARD-2", "CARD-3"]);
    expect(next.parallelism.allowedWriteScopes).toEqual(["apps/web", "apps/server"]);
    // The dialog depends on this: a detail save carries the existing brief over.
    expect(next.intentBrief?.intent).toBe("Ship it");
  });
});

describe("sortCardsForTable", () => {
  it("orders by area, then slice, then priority, then title", () => {
    const sorted = sortCardsForTable([
      card("Y"),
      card("N", { area: "Core", slice: "Auth", priority: 2 }),
      card("A", { area: "Core", slice: "Auth", priority: 2 }),
      card("M", { area: "Core", slice: "Auth", priority: 1 }),
      card("Z", { area: "Core", slice: "Api", priority: 5 }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["Z", "M", "A", "N", "Y"]);
  });
});

describe("newCardForState", () => {
  it("builds a decodable Ready card with an intent brief", () => {
    const created = newCardForState("Wire the runner", "Ready", TIMESTAMP);
    expect(created.state).toBe("Ready");
    expect(created.intentBrief?.intent).toBe("Wire the runner");
    expect(created.runtime.attemptCount).toBe(0);
    expect(created.id.startsWith("TASK-20260101-")).toBe(true);
  });

  it("gives two cards created in the same millisecond different ids", () => {
    expect(newCardForState("First", "Draft", TIMESTAMP).id).not.toBe(
      newCardForState("Second", "Draft", TIMESTAMP).id,
    );
  });
});

describe("groupDependencyTreeCards", () => {
  it("groups by area and slice and sorts cards by priority", () => {
    // Titles deliberately disagree with priority order, so a dropped priority
    // tiebreak cannot pass by falling through to the title comparison.
    const groups = groupDependencyTreeCards([
      card("A", { area: "Core", slice: "Auth", priority: 2 }),
      card("B", { area: "Core", slice: "Auth", priority: 1 }),
      card("C", { slice: "Auth" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.area).toBe("Core");
    expect(groups[0]?.cards.map((entry) => entry.id)).toEqual(["B", "A"]);
    expect(groups[1]?.area).toBe("Unassigned");
  });
});

describe("buildExecutionTree", () => {
  it("marks a cycle instead of recursing forever", () => {
    const rows = buildExecutionTree(boardWithCycle("A", "B"));
    expect(rows.some((row) => row.kind === "cycle" && row.cardId === "A")).toBe(true);
    expect(rows.some((row) => row.kind === "cycle" && row.cardId === "B")).toBe(true);
  });

  it("orders cards into dependency tiers", () => {
    const rows = buildExecutionTree(
      board([
        card("A", { area: "Core", dependencies: [] }),
        card("B", { area: "Core", dependencies: ["A"] as AgentBoardCardId[] }),
        card("C", { area: "Core", dependencies: ["B"] as AgentBoardCardId[] }),
      ]),
    );
    const depthById = new Map(
      rows.flatMap((row) => (row.kind === "card" ? [[row.cardId, row.depth]] : [])),
    );
    expect(depthById.get("A" as AgentBoardCardId)).toBe(0);
    expect(depthById.get("B" as AgentBoardCardId)).toBe(1);
    expect(depthById.get("C" as AgentBoardCardId)).toBe(2);
    expect(rows.filter((row) => row.kind === "tier").map((row) => row.label)).toEqual([
      "Foundations",
      "Build tier 2",
      "Finish pass",
    ]);
  });

  it("flags only the dependencies that are not on the board", () => {
    const rows = buildExecutionTree(
      board([
        card("A", { area: "Core", dependencies: ["B", "GHOST"] as AgentBoardCardId[] }),
        card("B", { area: "Core" }),
      ]),
    );
    const row = rows.find((entry) => entry.kind === "card" && entry.cardId === "A");
    expect(row?.kind === "card" && row.missingDependencyIds).toEqual(["GHOST"]);
  });

  it("keeps unconnected cards in their own section", () => {
    const rows = buildExecutionTree(
      board([
        card("A"),
        card("B", { area: "Future Scope" }),
        card("C", { area: "Core", dependencies: [] }),
      ]),
    );
    expect(rows.find((row) => row.kind === "card" && row.cardId === "A")?.section).toBe(
      "independent",
    );
    expect(rows.find((row) => row.kind === "card" && row.cardId === "B")?.section).toBe("future");
    // An area-tagged card with no links is detached, not a Foundations tier.
    expect(rows.find((row) => row.kind === "card" && row.cardId === "C")?.section).toBe(
      "independent",
    );
    expect(rows.some((row) => row.kind === "tier")).toBe(false);
  });
});

describe("intentSaveError", () => {
  const blank = intentDraftFromCard(card("A"));

  it("lets a Draft card with no brief save detail-only edits", () => {
    expect(intentSaveError(card("A"), blank)).toBeNull();
  });

  it("refuses when blanking the intent would drop an existing brief", () => {
    const withBrief = card("A", {
      intentBrief: {
        intent: "old",
        acceptanceCriteria: [],
        constraints: [],
        nonGoals: [],
        openDecisions: [],
      },
    });
    expect(intentSaveError(withBrief, blank)).toBe("Intent is required before saving a brief.");
  });

  it("refuses when the other intent fields were typed but the intent is blank", () => {
    expect(intentSaveError(card("A"), { ...blank, constraints: "no new deps" })).toBe(
      "Intent is required before saving a brief.",
    );
  });

  it("refuses on a Ready card even with nothing else filled in", () => {
    expect(intentSaveError(card("A", { state: "Ready" }), blank)).toBe(
      "Intent is required before saving a brief.",
    );
  });

  it("saves once the intent itself is filled in", () => {
    const ready = card("A", { state: "Ready" });
    expect(intentSaveError(ready, { ...blank, intent: "ship it" })).toBeNull();
  });
});

describe("isBoardConflictError", () => {
  it("recognises the server's stale-snapshot refusal", () => {
    expect(
      isBoardConflictError(
        "Agent board changed on disk since 2026-01-01T00:00:00.000Z; reload and try again.",
      ),
    ).toBe(true);
  });

  it("leaves every other save failure to the generic path", () => {
    expect(isBoardConflictError("Could not write .t3/agent-board.json: EACCES")).toBe(false);
    expect(isBoardConflictError("The agent board changed on disk")).toBe(false);
  });
});

describe("runCardError", () => {
  const ready = card("CARD-1", { state: "Ready" });
  const runnerOn = (file: AgentBoardFile): AgentBoardFile => ({
    ...file,
    runner: { ...file.runner, enabled: true },
  });

  it("lets a Ready card run while the runner is off", () => {
    expect(runCardError(ready, board([ready]))).toBeNull();
  });

  it("refuses a card that is not Ready and names the state it is in", () => {
    const draft = card("CARD-1");
    expect(runCardError(draft, board([draft]))).toBe(
      "Only a Ready card can be run by hand — CARD-1 is Draft.",
    );
  });

  it("refuses every card while the runner is enabled", () => {
    expect(runCardError(ready, runnerOn(board([ready])))).toBe(
      "The runner is enabled — turn it off to run a card by hand.",
    );
  });
});

describe("stateBadgeVariant", () => {
  it("tints the run states apart from the finished and blocked ones", () => {
    expect(stateBadgeVariant("Running")).toBe("warning");
    expect(stateBadgeVariant("Diagnosing")).toBe("warning");
    expect(stateBadgeVariant("Done")).toBe("success");
    expect(stateBadgeVariant("Needs Decision")).toBe("error");
    expect(stateBadgeVariant("Blocked")).toBe("error");
  });

  it("leaves the states that carry no signal neutral", () => {
    expect(stateBadgeVariant("Draft")).toBe("outline");
    expect(stateBadgeVariant("Backlog")).toBe("outline");
    expect(stateBadgeVariant("Canceled")).toBe("outline");
  });
});

describe("cardRuntimeSummary", () => {
  const NOW = Date.parse("2026-01-01T12:00:00.000Z");

  it("summarises the live phase with its attempt and turn counters", () => {
    const running = card("A", {
      state: "Running",
      runtime: {
        attemptCount: 2,
        turnCount: 5,
        repairCycleCount: 1,
        reviewFindings: [],
        phase: "repairing",
      },
    });
    expect(cardRuntimeSummary(running, NOW).phase).toBe("repairing · attempt 2 · turn 5");
  });

  it("shows no phase badge on a card the runner never picked up", () => {
    expect(cardRuntimeSummary(card("A"), NOW).phase).toBeNull();
  });

  it("counts the backoff down to the second and stops once it has elapsed", () => {
    const pending = (nextRetryAt: string) =>
      card("A", {
        state: "Diagnosing",
        runtime: {
          attemptCount: 1,
          turnCount: 1,
          repairCycleCount: 0,
          reviewFindings: [],
          nextRetryAt,
        },
      });
    expect(cardRuntimeSummary(pending("2026-01-01T12:01:05.000Z"), NOW).retryIn).toBe(
      "retry in 01:05",
    );
    expect(cardRuntimeSummary(pending("2026-01-01T12:10:00.000Z"), NOW).retryIn).toBe(
      "retry in 10:00",
    );
    // A sub-second remainder rounds up, so the label never shows 00:00 while
    // the card is still waiting.
    expect(cardRuntimeSummary(pending("2026-01-01T12:01:05.400Z"), NOW).retryIn).toBe(
      "retry in 01:06",
    );
    expect(cardRuntimeSummary(pending("2026-01-01T11:59:59.000Z"), NOW).retryIn).toBeNull();
  });

  it("surfaces the decision question only while the card is actually waiting on one", () => {
    const runtime = {
      attemptCount: 1,
      turnCount: 1,
      repairCycleCount: 0,
      reviewFindings: [],
      currentDecisionQuestion: "Postgres or SQLite?",
    };
    expect(cardRuntimeSummary(card("A", { state: "Needs Decision", runtime }), NOW).question).toBe(
      "Postgres or SQLite?",
    );
    expect(cardRuntimeSummary(card("A", { state: "Running", runtime }), NOW).question).toBeNull();
  });

  it("passes the current error through and reports nothing when there is none", () => {
    const failing = card("A", {
      runtime: {
        attemptCount: 1,
        turnCount: 1,
        repairCycleCount: 0,
        reviewFindings: [],
        currentError: "worktree is dirty",
      },
    });
    expect(cardRuntimeSummary(failing, NOW).error).toBe("worktree is dirty");
    expect(cardRuntimeSummary(card("A"), NOW).error).toBeNull();
  });
});

describe("runnerStatusLine", () => {
  const NOW = Date.parse("2026-01-01T12:00:00.000Z");

  it("names the workflow file, the active card count and the tick age", () => {
    expect(
      runnerStatusLine(
        {
          enabled: true,
          workflowSource: "workflow-md",
          activeCardIds: ["A", "B"] as AgentBoardCardId[],
          lastTickAt: "2026-01-01T11:58:30.000Z",
        },
        NOW,
      ),
    ).toBe("workflow: WORKFLOW.md  ·  active: 2  ·  last tick 1m ago");
  });

  it("flags a broken WORKFLOW.md and names the config the runner fell back to", () => {
    expect(
      runnerStatusLine(
        {
          enabled: true,
          workflowSource: "last-known-good",
          workflowError: "maxTurns must be positive",
          activeCardIds: [],
          lastTickAt: "2026-01-01T11:59:57.000Z",
        },
        NOW,
      ),
    ).toBe(
      "workflow: invalid (last-known-good): maxTurns must be positive  ·  active: 0  ·  last tick 3s ago",
    );
  });

  it("says the runner has never ticked instead of inventing an age", () => {
    expect(
      runnerStatusLine({ enabled: false, workflowSource: "defaults", activeCardIds: [] }, NOW),
    ).toBe("workflow: defaults  ·  active: 0  ·  last tick never");
  });
});

describe("cardWithLaunchedRun", () => {
  const RUN_ID = RuntimeSessionId.make("thread-abc");
  const LAUNCHED_AT = "2026-02-02T00:00:00.000Z";
  // What `AgentBoardFileSystem.claim` leaves behind: Running, workspace
  // reserved, no thread recorded yet.
  const claimed = () =>
    card("CARD-1", {
      state: "Running",
      runtime: {
        attemptCount: 1,
        turnCount: 0,
        repairCycleCount: 0,
        reviewFindings: [],
        workspacePath: ".t3/workspaces/CARD-1",
      },
    });

  it("records the thread that owns the claimed workspace", () => {
    const launched = cardWithLaunchedRun(claimed(), { threadId: RUN_ID }, LAUNCHED_AT);
    expect(launched.state).toBe("Running");
    expect(launched.runtime.implementationRunId).toBe(RUN_ID);
  });

  // The runner skips manual cards outright, so this phase is what keeps it from
  // adopting, continuing or stopping a card a human started.
  it("marks the card manual so the runner leaves the human's run alone", () => {
    expect(cardWithLaunchedRun(claimed(), { threadId: RUN_ID }, LAUNCHED_AT).runtime.phase).toBe(
      "manual",
    );
  });

  it("keeps the workspace the claim reserved and stores the launch branch", () => {
    const launched = cardWithLaunchedRun(
      claimed(),
      { threadId: RUN_ID, branchName: "agent-board/CARD-1" },
      LAUNCHED_AT,
    );
    expect(launched.runtime.workspacePath).toBe(".t3/workspaces/CARD-1");
    expect(launched.runtime.branchName).toBe("agent-board/CARD-1");
  });

  it("counts the turn the launch is about to start", () => {
    expect(
      cardWithLaunchedRun(claimed(), { threadId: RUN_ID }, LAUNCHED_AT).runtime.turnCount,
    ).toBe(1);
  });

  it("drops the moment-in-time runtime fields a previous failure left behind", () => {
    const retried = card("CARD-1", {
      state: "Running",
      runtime: {
        attemptCount: 2,
        turnCount: 1,
        repairCycleCount: 1,
        reviewFindings: [],
        phase: "repairing",
        currentError: "worktree add failed",
        currentDecisionQuestion: "which branch?",
        nextRetryAt: "2026-02-01T00:00:00.000Z",
      },
    });
    const launched = cardWithLaunchedRun(retried, { threadId: RUN_ID }, LAUNCHED_AT);
    expect(launched.runtime.currentError).toBeUndefined();
    expect(launched.runtime.currentDecisionQuestion).toBeUndefined();
    expect(launched.runtime.nextRetryAt).toBeUndefined();
    expect(launched.runtime.attemptCount).toBe(2);
  });

  it("beats the heartbeat so the runner does not read the card as abandoned", () => {
    const launched = cardWithLaunchedRun(claimed(), { threadId: RUN_ID }, LAUNCHED_AT);
    expect(launched.runtime.lastHeartbeatAt).toBe(LAUNCHED_AT);
    expect(launched.updatedAt).toBe(LAUNCHED_AT);
  });
});

describe("cardWithLaunchFailure", () => {
  const FAILED_AT = "2026-02-02T00:00:00.000Z";
  const running = () =>
    card("CARD-1", {
      state: "Running",
      runtime: {
        attemptCount: 1,
        turnCount: 0,
        repairCycleCount: 0,
        reviewFindings: [],
        workspacePath: ".t3/workspaces/CARD-1",
      },
    });

  it("parks the card as the human's, out of Running and out of the runner's way", () => {
    const parked = cardWithLaunchFailure(running(), { error: "worktree add failed" }, FAILED_AT);
    expect(parked.state).toBe("Diagnosing");
    expect(parked.runtime.phase).toBe("manual");
    expect(parked.runtime.currentError).toBe("worktree add failed");
  });

  it("keeps missing-model failures editable", () => {
    const parked = cardWithLaunchFailure(
      running(),
      { error: "Choose a model", missingModel: true },
      FAILED_AT,
    );
    expect(parked.state).toBe("Needs Decision");
    const selection = {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "mtplx/local",
      options: [],
    };
    expect(
      cardWithDetailDraft(parked, { ...detailDraftFromCard(parked), modelSelection: selection })
        .modelSelection,
    ).toEqual(selection);
  });

  /**
   * A failed manual launch may have opened a thread, but that thread is a
   * client draft with no server thread behind it until the user sends. Writing
   * its id here would point the runner at a worker that never existed.
   */
  it("records no run id, so the runner cannot mistake the card for a dead worker", () => {
    const parked = cardWithLaunchFailure(running(), { error: "board save failed" }, FAILED_AT);
    expect(parked.runtime.implementationRunId).toBeUndefined();
  });

  it("falls back to a usable message so the board save cannot reject a blank error", () => {
    expect(cardWithLaunchFailure(running(), { error: "   " }, FAILED_AT).runtime.currentError).toBe(
      "Could not launch this card.",
    );
  });

  it("keeps the reserved workspace so the retry lands in the same worktree", () => {
    const parked = cardWithLaunchFailure(running(), { error: "boom" }, FAILED_AT);
    expect(parked.runtime.workspacePath).toBe(".t3/workspaces/CARD-1");
    expect(parked.runtime.lastHeartbeatAt).toBe(FAILED_AT);
  });
});

describe("task model override", () => {
  it("saves a selected agent and can return to the project default", () => {
    const original = card("A");
    const modelSelection = {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "mtplx/local",
      options: [],
    };
    const selected = cardWithDetailDraft(original, {
      ...detailDraftFromCard(original),
      modelSelection,
    });
    expect(selected.modelSelection).toEqual(modelSelection);
    const running = { ...selected, state: "Running" as const };
    expect(
      cardWithDetailDraft(running, { ...detailDraftFromCard(running), modelSelection: null })
        .modelSelection,
    ).toEqual(modelSelection);
    expect(detailDraftFromCard(selected).modelSelection).toEqual(modelSelection);
    const cleared = cardWithDetailDraft(selected, {
      ...detailDraftFromCard(selected),
      modelSelection: null,
    });
    expect(cleared.modelSelection).toBeUndefined();
  });
});
