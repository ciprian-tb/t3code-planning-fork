/**
 * Pure board transformations shared by the Kanban, planning table and
 * dependency tree views. Everything here is a plain function over decoded
 * `AgentBoardFile` values — no RPC, no React, no component state.
 */
import {
  AgentBoardCard as AgentBoardCardSchema,
  type AgentBoardCard,
  type AgentBoardCardId,
  type AgentBoardFile,
  type AgentBoardIntentBrief,
  type AgentBoardState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const UNASSIGNED_AREA_LABEL = "Unassigned";
const FUTURE_SCOPE_AREA_LABEL = "Future Scope";
const UNASSIGNED_SLICE_LABEL = "Unassigned slice";

export const BOARD_COLUMNS: ReadonlyArray<{ state: AgentBoardState; label: string }> = [
  { state: "Draft", label: "Draft" },
  { state: "Ready", label: "Ready" },
  { state: "Running", label: "Running" },
  { state: "Review", label: "Review" },
  { state: "Done", label: "Done" },
  { state: "Needs Decision", label: "Needs Decision" },
];

/** States a human may move a card into by hand. */
export const MOVABLE_STATES: readonly AgentBoardState[] = [
  "Draft",
  "Backlog",
  "Ready",
  "Running",
  "Review",
  "Done",
  "Needs Decision",
  "Blocked",
  "Canceled",
];

export const PARALLELISM_SAFETY_OPTIONS = ["false", "true", "conditional"] as const;

export interface IntentDraft {
  intent: string;
  desiredOutcome: string;
  acceptanceCriteria: string;
  constraints: string;
  nonGoals: string;
  openDecisions: string;
}

export interface DetailDraft {
  title: string;
  area: string;
  slice: string;
  slicePlanPath: string;
  dependencies: string;
  parallelismSafe: (typeof PARALLELISM_SAFETY_OPTIONS)[number];
  parallelismReason: string;
  conflictsWith: string;
  allowedWriteScopes: string;
}

export interface DependencyTreeGroup {
  readonly area: string;
  readonly slice: string;
  readonly cards: readonly AgentBoardCard[];
}

export type ExecutionTreeSection = "path" | "independent" | "future";

/**
 * A flat, render-ready traversal of the board's dependency graph. Flat rows
 * keep the view dumb and let cycles be reported as data instead of blowing the
 * stack in a recursive renderer.
 */
export type ExecutionTreeRow =
  | {
      readonly kind: "section";
      readonly key: string;
      readonly label: string;
      readonly section: ExecutionTreeSection;
    }
  | {
      readonly kind: "tier";
      readonly key: string;
      readonly label: string;
      readonly depth: number;
      readonly section: ExecutionTreeSection;
    }
  | {
      readonly kind: "card";
      readonly key: string;
      readonly cardId: AgentBoardCardId;
      readonly card: AgentBoardCard;
      readonly depth: number;
      readonly section: ExecutionTreeSection;
      readonly missingDependencyIds: readonly AgentBoardCardId[];
    }
  | {
      readonly kind: "cycle";
      readonly key: string;
      readonly cardId: AgentBoardCardId;
      readonly card: AgentBoardCard;
      readonly section: ExecutionTreeSection;
      readonly cycleWith: readonly AgentBoardCardId[];
    };

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function optionalTrimmedValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function planningAreaForCard(card: AgentBoardCard): string {
  return card.area?.trim() || UNASSIGNED_AREA_LABEL;
}

function planningSliceForCard(card: AgentBoardCard): string {
  return card.slice?.trim() || UNASSIGNED_SLICE_LABEL;
}

export function stateTone(state: AgentBoardState): string {
  switch (state) {
    case "Ready":
      return "border-blue-500/30 bg-blue-500/10 text-blue-300";
    case "Running":
    case "Diagnosing":
      return "border-amber-500/30 bg-amber-500/10 text-amber-300";
    case "Review":
    case "Reviewing":
      return "border-violet-500/30 bg-violet-500/10 text-violet-300";
    case "Done":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
    case "Needs Decision":
    case "Blocked":
      return "border-rose-500/30 bg-rose-500/10 text-rose-300";
    default:
      return "border-border/70 bg-muted/30 text-muted-foreground";
  }
}

export function intentDraftFromCard(card: AgentBoardCard): IntentDraft {
  return {
    intent: card.intentBrief?.intent ?? "",
    desiredOutcome: card.intentBrief?.desiredOutcome ?? "",
    acceptanceCriteria: (card.intentBrief?.acceptanceCriteria ?? []).join("\n"),
    constraints: (card.intentBrief?.constraints ?? []).join("\n"),
    nonGoals: (card.intentBrief?.nonGoals ?? []).join("\n"),
    openDecisions: (card.intentBrief?.openDecisions ?? []).join("\n"),
  };
}

/** `null` when the mandatory intent line is blank — a brief without intent is not a brief. */
export function intentBriefFromDraft(draft: IntentDraft): AgentBoardIntentBrief | null {
  const intent = draft.intent.trim();
  if (!intent) return null;
  const desiredOutcome = optionalTrimmedValue(draft.desiredOutcome);
  return {
    intent,
    ...(desiredOutcome ? { desiredOutcome } : {}),
    acceptanceCriteria: splitLines(draft.acceptanceCriteria),
    constraints: splitLines(draft.constraints),
    nonGoals: splitLines(draft.nonGoals),
    openDecisions: splitLines(draft.openDecisions),
  };
}

export function detailDraftFromCard(card: AgentBoardCard): DetailDraft {
  return {
    title: card.title,
    area: card.area ?? "",
    slice: card.slice ?? "",
    slicePlanPath: card.slicePlanPath ?? "",
    dependencies: card.dependencies.join("\n"),
    parallelismSafe: card.parallelism.safe,
    parallelismReason: card.parallelism.reason ?? "",
    conflictsWith: card.parallelism.conflictsWith.join("\n"),
    allowedWriteScopes: card.parallelism.allowedWriteScopes.join("\n"),
  };
}

function cardIdsFromDraft(value: string): AgentBoardCardId[] {
  return splitLines(value) as AgentBoardCardId[];
}

/** Applies the whole detail draft back onto a card, dropping blanked-out optional keys. */
export function cardWithDetailDraft(card: AgentBoardCard, draft: DetailDraft): AgentBoardCard {
  const {
    area: _area,
    slice: _slice,
    slicePlanPath: _slicePlanPath,
    ...withoutPlanningFields
  } = card;
  const area = optionalTrimmedValue(draft.area);
  const slice = optionalTrimmedValue(draft.slice);
  const slicePlanPath = optionalTrimmedValue(draft.slicePlanPath);
  const reason = optionalTrimmedValue(draft.parallelismReason);
  return {
    ...withoutPlanningFields,
    title: draft.title.trim() || card.title,
    dependencies: cardIdsFromDraft(draft.dependencies),
    parallelism: {
      safe: draft.parallelismSafe,
      ...(reason ? { reason } : {}),
      conflictsWith: cardIdsFromDraft(draft.conflictsWith),
      allowedWriteScopes: splitLines(draft.allowedWriteScopes),
    },
    ...(area ? { area } : {}),
    ...(slice ? { slice } : {}),
    ...(slicePlanPath ? { slicePlanPath } : {}),
  } as AgentBoardCard;
}

const decodeCard = Schema.decodeUnknownSync(AgentBoardCardSchema);

export function newCardForState(
  title: string,
  state: AgentBoardState,
  timestamp = new Date().toISOString(),
): AgentBoardCard {
  return decodeCard({
    id: `TASK-${timestamp.slice(0, 10).replaceAll("-", "")}-${Date.parse(timestamp) || Date.now()}`,
    title,
    state,
    priority: 3,
    ...(state === "Ready" ? { intentBrief: { intent: title } } : {}),
    parallelism: {
      safe: "conditional",
      reason: "New board card needs clarification before parallel execution.",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/** `Ready` is the one state that requires an intent brief, so synthesise one on promotion. */
export function cardWithState(
  card: AgentBoardCard,
  state: AgentBoardState,
  timestamp: string,
): AgentBoardCard {
  return {
    ...card,
    state,
    ...(state === "Ready" && !card.intentBrief
      ? {
          intentBrief: {
            intent: card.title,
            acceptanceCriteria: [],
            constraints: [],
            nonGoals: [],
            openDecisions: [],
          },
        }
      : {}),
    updatedAt: timestamp,
  } as AgentBoardCard;
}

export function cardWithPlanningField(
  card: AgentBoardCard,
  field: "area" | "slice" | "slicePlanPath",
  value: string,
): AgentBoardCard {
  const trimmed = optionalTrimmedValue(value);
  if (trimmed) return { ...card, [field]: trimmed } as AgentBoardCard;
  const { [field]: _omitted, ...rest } = card;
  return rest as AgentBoardCard;
}

/** Immutable single-card edit; returns the same board reference when nothing matches. */
export function updateCard(
  board: AgentBoardFile,
  cardId: AgentBoardCardId,
  updater: (card: AgentBoardCard) => AgentBoardCard,
  timestamp = new Date().toISOString(),
): AgentBoardFile {
  if (!board.cards.some((card) => card.id === cardId)) return board;
  return {
    ...board,
    cards: board.cards.map((card) =>
      card.id === cardId ? updater({ ...card, updatedAt: timestamp }) : card,
    ),
    updatedAt: timestamp,
  };
}

export function addCard(
  board: AgentBoardFile,
  card: AgentBoardCard,
  timestamp = new Date().toISOString(),
): AgentBoardFile {
  return { ...board, cards: [...board.cards, card], updatedAt: timestamp };
}

export function sortCardsForTable(cards: readonly AgentBoardCard[]): AgentBoardCard[] {
  return cards.toSorted(
    (first, second) =>
      planningAreaForCard(first).localeCompare(planningAreaForCard(second)) ||
      (first.slice ?? "").localeCompare(second.slice ?? "") ||
      first.priority - second.priority ||
      first.title.localeCompare(second.title),
  );
}

export function groupDependencyTreeCards(cards: readonly AgentBoardCard[]): DependencyTreeGroup[] {
  const groups = new Map<string, { area: string; slice: string; cards: AgentBoardCard[] }>();
  for (const card of cards) {
    const area = planningAreaForCard(card);
    const slice = planningSliceForCard(card);
    const key = `${area} / ${slice}`;
    const existing = groups.get(key);
    if (existing) existing.cards.push(card);
    else groups.set(key, { area, slice, cards: [card] });
  }
  return Array.from(groups.values())
    .map((group) => ({
      area: group.area,
      slice: group.slice,
      cards: group.cards.toSorted(
        (first, second) =>
          first.priority - second.priority || first.title.localeCompare(second.title),
      ),
    }))
    .toSorted(
      (first, second) =>
        first.area.localeCompare(second.area) || first.slice.localeCompare(second.slice),
    );
}

/**
 * Marks every card that sits on a dependency cycle. Colour-marked DFS, so a
 * mutually-dependent pair is reported once instead of recursing forever.
 */
function findCycleCardIds(cards: readonly AgentBoardCard[]): ReadonlySet<string> {
  const dependenciesById = new Map(cards.map((card) => [card.id as string, card.dependencies]));
  const cyclic = new Set<string>();
  const visitState = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const state = visitState.get(id);
    if (state === "done") return;
    if (state === "visiting") {
      for (const member of stack.slice(stack.indexOf(id))) cyclic.add(member);
      return;
    }
    visitState.set(id, "visiting");
    stack.push(id);
    for (const dependencyId of dependenciesById.get(id) ?? []) {
      if (dependenciesById.has(dependencyId)) visit(dependencyId);
    }
    stack.pop();
    visitState.set(id, "done");
  };

  for (const card of cards) visit(card.id);
  return cyclic;
}

function tierLabel(index: number, lastIndex: number, depth: number): string {
  if (index === 0) return "Foundations";
  if (index === lastIndex) return "Finish pass";
  return `Build tier ${depth + 1}`;
}

/**
 * Flattens the board into ordered rows: dependency tiers for the connected
 * path, then detached cards, future scope, and finally any cards trapped in a
 * cycle.
 */
export function buildExecutionTree(board: AgentBoardFile): ExecutionTreeRow[] {
  const cards = board.cards;
  const cardById = new Map(cards.map((card) => [card.id as string, card]));
  const missingDependencies = (card: AgentBoardCard) =>
    card.dependencies.filter((dependencyId) => !cardById.has(dependencyId));

  const futureCards = cards.filter((card) => planningAreaForCard(card) === FUTURE_SCOPE_AREA_LABEL);
  const unassignedCards = cards.filter(
    (card) => planningAreaForCard(card) === UNASSIGNED_AREA_LABEL,
  );
  const activeCards = cards.filter((card) => {
    const area = planningAreaForCard(card);
    return area !== FUTURE_SCOPE_AREA_LABEL && area !== UNASSIGNED_AREA_LABEL;
  });
  const activeIds = new Set(activeCards.map((card) => card.id as string));
  const hasActiveDependents = new Set(
    activeCards.flatMap((card) =>
      card.dependencies.filter((dependencyId) => activeIds.has(dependencyId)),
    ),
  );
  const detachedCards = activeCards.filter(
    (card) =>
      !card.dependencies.some((dependencyId) => activeIds.has(dependencyId)) &&
      !hasActiveDependents.has(card.id),
  );
  const detachedIds = new Set(detachedCards.map((card) => card.id as string));
  const pathCards = activeCards.filter((card) => !detachedIds.has(card.id));
  const pathIds = new Set(pathCards.map((card) => card.id as string));

  const cyclicIds = findCycleCardIds(pathCards);
  const acyclicPathCards = pathCards.filter((card) => !cyclicIds.has(card.id));
  const acyclicIds = new Set(acyclicPathCards.map((card) => card.id as string));

  const depthCache = new Map<string, number>();
  const depthForCard = (card: AgentBoardCard): number => {
    const cached = depthCache.get(card.id);
    if (cached !== undefined) return cached;
    // Seeded before recursing so a stray edge cannot re-enter this card.
    depthCache.set(card.id, 0);
    const dependencyDepths = card.dependencies
      .filter((dependencyId) => acyclicIds.has(dependencyId))
      .map((dependencyId) => depthForCard(cardById.get(dependencyId) as AgentBoardCard));
    const depth = dependencyDepths.length ? Math.max(...dependencyDepths) + 1 : 0;
    depthCache.set(card.id, depth);
    return depth;
  };

  const tiers = new Map<number, AgentBoardCard[]>();
  for (const card of acyclicPathCards) {
    const depth = depthForCard(card);
    tiers.set(depth, [...(tiers.get(depth) ?? []), card]);
  }
  const orderedTiers = Array.from(tiers.entries()).toSorted(([first], [second]) => first - second);

  const rows: ExecutionTreeRow[] = [];
  const pushCards = (
    group: readonly AgentBoardCard[],
    section: ExecutionTreeSection,
    depth: number,
  ) => {
    for (const treeGroup of groupDependencyTreeCards(group)) {
      for (const card of treeGroup.cards) {
        rows.push({
          kind: "card",
          key: `card:${card.id}`,
          cardId: card.id,
          card,
          depth,
          section,
          missingDependencyIds: missingDependencies(card),
        });
      }
    }
  };

  for (const [index, [depth, tierCards]] of orderedTiers.entries()) {
    rows.push({
      kind: "tier",
      key: `tier:${depth}`,
      label: tierLabel(index, orderedTiers.length - 1, depth),
      depth,
      section: "path",
    });
    pushCards(tierCards, "path", depth);
  }

  const independentCards = [...unassignedCards, ...detachedCards];
  if (independentCards.length > 0) {
    rows.push({
      kind: "section",
      key: "section:independent",
      label: "Independent cards",
      section: "independent",
    });
    pushCards(independentCards, "independent", 0);
  }

  if (futureCards.length > 0) {
    rows.push({
      kind: "section",
      key: "section:future",
      label: "Future scope",
      section: "future",
    });
    pushCards(futureCards, "future", 0);
  }

  const cyclicCards = pathCards.filter((card) => cyclicIds.has(card.id));
  if (cyclicCards.length > 0) {
    rows.push({
      kind: "section",
      key: "section:cycles",
      label: "Dependency cycles",
      section: "path",
    });
    for (const card of cyclicCards) {
      rows.push({
        kind: "cycle",
        key: `cycle:${card.id}`,
        cardId: card.id,
        card,
        section: "path",
        cycleWith: card.dependencies.filter(
          (dependencyId) => cyclicIds.has(dependencyId) && pathIds.has(dependencyId),
        ),
      });
    }
  }

  return rows;
}
