import type { AgentBoardCard, AgentBoardCardId, AgentBoardFile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildExecutionTree,
  cardWithDetailDraft,
  cardWithPlanningField,
  cardWithState,
  detailDraftFromCard,
  groupDependencyTreeCards,
  intentBriefFromDraft,
  intentDraftFromCard,
  newCardForState,
  sortCardsForTable,
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
