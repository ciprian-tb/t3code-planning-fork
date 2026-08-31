import type { AgentBoardCard } from "@t3tools/contracts";

/**
 * Answering a `Needs Decision` card: the answer becomes a durable constraint on
 * the intent brief (so the next worker prompt carries it), and the card goes
 * back into the runner's queue. `Ready` needs a brief, so a card without one
 * lands in `Draft` for a human to finish.
 */
export function answerDecision(card: AgentBoardCard, answer: string, now: string): AgentBoardCard {
  const question = card.runtime.currentDecisionQuestion ?? "Decision";
  const {
    currentDecisionQuestion: _question,
    currentError: _error,
    nextRetryAt: _retry,
    phase: _phase,
    ...runtime
  } = card.runtime;
  const answered = { ...card, runtime: { ...runtime, lastHeartbeatAt: now }, updatedAt: now };
  // `intentBrief` stays an absent key rather than an explicit `undefined`, so
  // the card still encodes against the schema's `optionalKey`.
  return (
    card.intentBrief
      ? {
          ...answered,
          state: "Ready",
          intentBrief: {
            ...card.intentBrief,
            constraints: [...card.intentBrief.constraints, `${question} → ${answer.trim()}`],
          },
        }
      : { ...answered, state: "Draft" }
  ) as AgentBoardCard;
}
