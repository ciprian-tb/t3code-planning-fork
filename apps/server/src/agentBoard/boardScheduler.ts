import type {
  AgentBoardCard,
  AgentBoardCardId,
  AgentBoardFile,
  AgentBoardState,
  AgentBoardWorkflowConfig,
  RuntimeSessionId,
} from "@t3tools/contracts";

/** States where a runner turn owns the card; they consume a concurrency slot. */
export const RUNNER_OWNED_STATES: ReadonlySet<AgentBoardState> = new Set([
  "Running",
  "Diagnosing",
  "Reviewing",
]);

const isParallelSafe = (card: AgentBoardCard) => card.parallelism.safe === "true";
const conflicts = (a: AgentBoardCard, b: AgentBoardCard) =>
  a.parallelism.conflictsWith.includes(b.id) || b.parallelism.conflictsWith.includes(a.id);

/**
 * Which `Ready` cards the runner may launch right now: dependencies satisfied
 * (an unknown dependency id blocks forever — it is a broken board, not a
 * finished one), a free concurrency slot, and no unsafe overlap with cards
 * already in flight. Pure: it decides, the caller claims.
 */
export function selectClaimableCards(
  board: AgentBoardFile,
  config: AgentBoardWorkflowConfig,
): ReadonlyArray<AgentBoardCard> {
  const byId = new Map(board.cards.map((c) => [c.id, c] as const));
  const running = board.cards.filter((c) => RUNNER_OWNED_STATES.has(c.state));
  let slots = config.agent.maxConcurrentAgents - running.length;
  if (slots <= 0) return [];

  const candidates = board.cards
    .filter((c) => c.state === "Ready" && c.intentBrief !== undefined)
    .filter((c) => c.dependencies.every((id) => byId.get(id)?.state === "Done"))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );

  const picked: AgentBoardCard[] = [];
  for (const card of candidates) {
    if (slots === 0) break;
    const others = [...running, ...picked];
    const ok =
      others.length === 0 ||
      (isParallelSafe(card) && others.every((o) => isParallelSafe(o) && !conflicts(card, o)));
    if (!ok) continue;
    picked.push(card);
    slots -= 1;
  }
  return picked;
}

/** Exponential backoff from 1s, doubling per attempt, capped at `maxBackoffMs`. */
export function retryDelayMs(attemptCount: number, maxBackoffMs: number): number {
  return Math.min(maxBackoffMs, 1000 * 2 ** Math.max(0, attemptCount - 1));
}

export type Transition =
  | { kind: "launched"; threadId: RuntimeSessionId; branchName?: string }
  | { kind: "continued" }
  | { kind: "review-started"; threadId: RuntimeSessionId; summary?: string }
  | { kind: "repair"; findings: ReadonlyArray<string> }
  | { kind: "retry-later"; error: string; nextRetryAt: string; relaunch?: boolean | undefined }
  | { kind: "review-failed"; error: string; nextRetryAt: string }
  | { kind: "success"; state: "Review" | "Done"; summary: string }
  | { kind: "needs-decision"; question: string; summary?: string }
  | { kind: "blocked"; error: string };

/**
 * Applies one runner outcome to a card. Transient runtime fields (`phase`,
 * `currentError`, `nextRetryAt`, `currentDecisionQuestion`) are dropped first
 * so every transition re-states only what is still true — no stale error
 * surviving a successful relaunch.
 */
export function transition(card: AgentBoardCard, t: Transition, now: string): AgentBoardCard {
  const {
    currentError: _e,
    currentDecisionQuestion: _q,
    nextRetryAt: _r,
    phase: _p,
    ...base
  } = card.runtime;
  const rt = { ...base, lastHeartbeatAt: now };
  const set = (state: AgentBoardState, runtime: AgentBoardCard["runtime"]): AgentBoardCard =>
    // ponytail: Object.assign keeps the Ready/NonReady union happy without re-narrowing intentBrief.
    Object.assign({}, card, { state, runtime, updatedAt: now }) as AgentBoardCard;

  switch (t.kind) {
    case "launched":
      return set("Running", {
        ...rt,
        phase: "implementing",
        implementationRunId: t.threadId,
        turnCount: rt.turnCount + 1,
        ...(t.branchName ? { branchName: t.branchName } : {}),
      });
    case "continued":
      return set("Running", { ...rt, phase: "implementing", turnCount: rt.turnCount + 1 });
    case "review-started":
      return set("Reviewing", {
        ...rt,
        phase: "reviewing",
        reviewRunId: t.threadId,
        turnCount: rt.turnCount + 1,
        // Kept on the card so a replacement reviewer still gets the
        // implementer's summary after the first one dies.
        ...(t.summary === undefined ? {} : { lastResultSummary: t.summary }),
      });
    case "repair":
      return set("Diagnosing", {
        ...rt,
        phase: "repairing",
        repairCycleCount: rt.repairCycleCount + 1,
        reviewFindings: [...t.findings],
      });
    case "retry-later": {
      // `relaunch` means the worker thread itself is gone, not that its turn
      // failed: drop the run id so the retry pass takes the re-launch branch
      // and builds a fresh thread on the same worktree. Continuing a dead
      // conversation only fails again, once per attempt, until the card parks.
      const { implementationRunId: _dead, ...withoutWorker } = rt;
      // The board's `claim` only counts the initial claim; a failure after a
      // continuation has to count too, or backoff never grows.
      return set("Diagnosing", {
        ...(t.relaunch === true ? withoutWorker : rt),
        phase: "repairing",
        attemptCount: rt.attemptCount + 1,
        currentError: t.error,
        nextRetryAt: t.nextRetryAt,
      });
    }
    case "review-failed": {
      // The reviewer's own session died: drop its thread and stay in the
      // reviewing phase, so the retry pass starts a fresh reviewer instead of
      // telling the implementer its turn failed.
      const { reviewRunId: _dead, ...withoutReviewer } = rt;
      return set("Diagnosing", {
        ...withoutReviewer,
        phase: "reviewing",
        attemptCount: rt.attemptCount + 1,
        currentError: t.error,
        nextRetryAt: t.nextRetryAt,
      });
    }
    case "success":
      return set(t.state, { ...rt, reviewFindings: [], lastResultSummary: t.summary });
    case "needs-decision":
      return set("Needs Decision", {
        ...rt,
        currentDecisionQuestion: t.question,
        ...(t.summary ? { lastResultSummary: t.summary } : {}),
      });
    case "blocked":
      return set("Blocked", { ...rt, currentError: t.error });
  }
}

/** Immutable single-card update; stamps `updatedAt` and the card heartbeat. */
export function patchCard(
  board: AgentBoardFile,
  cardId: AgentBoardCardId,
  patch: (card: AgentBoardCard) => AgentBoardCard,
  now: string,
): AgentBoardFile {
  const stamp = (card: AgentBoardCard): AgentBoardCard => {
    const patched = patch(card);
    return Object.assign({}, patched, {
      updatedAt: now,
      runtime: { ...patched.runtime, lastHeartbeatAt: now },
    }) as AgentBoardCard;
  };
  return {
    ...board,
    cards: board.cards.map((c) => (c.id === cardId ? stamp(c) : c)),
    updatedAt: now,
  };
}
