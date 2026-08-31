import type { AgentBoardCard, AgentBoardState } from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import { memo, useState } from "react";

import { answerDecision } from "./agentBoardDecision";
import {
  MOVABLE_STATES,
  PARALLELISM_SAFETY_OPTIONS,
  type DetailDraft,
  type IntentDraft,
  cardWithDetailDraft,
  detailDraftFromCard,
  intentBriefFromDraft,
  intentDraftFromCard,
  intentSaveError,
} from "./agentBoardModel";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

interface AgentBoardCardDialogProps {
  readonly card: AgentBoardCard | null;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (card: AgentBoardCard) => void;
  readonly onMoveCard: (card: AgentBoardCard, state: AgentBoardState) => void;
  readonly onRunCard: (card: AgentBoardCard) => void;
}

function LabeledField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="space-y-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function RuntimeStat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 p-3">
      <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/60 uppercase">
        {label}
      </p>
      <p className="mt-1 truncate text-sm text-foreground">{value}</p>
    </div>
  );
}

export const AgentBoardCardDialog = memo(function AgentBoardCardDialog({
  card,
  busy,
  onOpenChange,
  onSave,
  onMoveCard,
  onRunCard,
}: AgentBoardCardDialogProps) {
  const [editedCardId, setEditedCardId] = useState<string | null>(null);
  const [detailDraft, setDetailDraft] = useState<DetailDraft | null>(null);
  const [intentDraft, setIntentDraft] = useState<IntentDraft | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset the drafts during render whenever the open card changes — including
  // closing, which lands on `null` — so the dialog never shows the previous
  // card's text and reopening never resurrects abandoned edits.
  if ((card?.id ?? null) !== editedCardId) {
    setEditedCardId(card?.id ?? null);
    setDetailDraft(card ? detailDraftFromCard(card) : null);
    setIntentDraft(card ? intentDraftFromCard(card) : null);
    setAnswer("");
    setError(null);
  }

  const handleSave = () => {
    if (!card || !detailDraft || !intentDraft) return;
    const blocked = intentSaveError(card, intentDraft);
    if (blocked) {
      setError(blocked);
      return;
    }
    const intentBrief = intentBriefFromDraft(intentDraft);
    const next = cardWithDetailDraft(card, detailDraft);
    onSave((intentBrief ? { ...next, intentBrief } : next) as AgentBoardCard);
    onOpenChange(false);
  };

  // The answer is applied to the card as the server last saw it, not to the
  // open drafts: unblocking a stuck card should not smuggle in half-typed edits.
  const handleAnswer = () => {
    if (!card) return;
    onSave(answerDecision(card, answer, new Date().toISOString()));
    onOpenChange(false);
  };

  return (
    <Dialog open={card !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl">
        {card && detailDraft && intentDraft ? (
          <>
            <DialogHeader>
              <DialogTitle className="pr-8 text-base">Card details</DialogTitle>
              <DialogDescription>{card.id}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
                <LabeledField label="Title">
                  <Input
                    value={detailDraft.title}
                    onChange={(event) =>
                      setDetailDraft({ ...detailDraft, title: event.currentTarget.value })
                    }
                    className="h-9 text-sm"
                  />
                </LabeledField>
                <LabeledField label="State">
                  <Select
                    value={card.state}
                    onValueChange={(value) => onMoveCard(card, value as AgentBoardState)}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue>{card.state}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {MOVABLE_STATES.map((state) => (
                        <SelectItem key={state} value={state}>
                          {state}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </LabeledField>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <LabeledField label="Area">
                  <Input
                    value={detailDraft.area}
                    onChange={(event) =>
                      setDetailDraft({ ...detailDraft, area: event.currentTarget.value })
                    }
                    placeholder="Frontend, Backend, Admin"
                    className="h-9 text-sm"
                  />
                </LabeledField>
                <LabeledField label="Slice">
                  <Input
                    value={detailDraft.slice}
                    onChange={(event) =>
                      setDetailDraft({ ...detailDraft, slice: event.currentTarget.value })
                    }
                    className="h-9 text-sm"
                  />
                </LabeledField>
                <LabeledField label="Slice plan">
                  <Input
                    value={detailDraft.slicePlanPath}
                    onChange={(event) =>
                      setDetailDraft({ ...detailDraft, slicePlanPath: event.currentTarget.value })
                    }
                    placeholder="docs/agents/slices/..."
                    className="h-9 text-sm"
                  />
                </LabeledField>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <RuntimeStat label="Phase" value={card.runtime.phase ?? "Idle"} />
                <RuntimeStat label="Attempts" value={String(card.runtime.attemptCount)} />
                <RuntimeStat label="Turns" value={String(card.runtime.turnCount)} />
              </div>
              {card.runtime.currentError ? (
                <p className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[12px] text-rose-200">
                  {card.runtime.currentError}
                </p>
              ) : null}
              {card.state === "Needs Decision" ? (
                <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                  <p className="text-[12px] text-amber-100">
                    {card.runtime.currentDecisionQuestion ?? "This card is waiting on a decision."}
                  </p>
                  <Textarea
                    value={answer}
                    onChange={(event) => setAnswer(event.currentTarget.value)}
                    placeholder="Answer the question; it is kept as a constraint on the brief."
                    className="min-h-16 text-sm"
                  />
                  <Button size="xs" onClick={handleAnswer} disabled={busy || !answer.trim()}>
                    Answer &amp; re-run
                  </Button>
                </div>
              ) : card.runtime.currentDecisionQuestion ? (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-100">
                  {card.runtime.currentDecisionQuestion}
                </p>
              ) : null}

              <div className="grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-2">
                <LabeledField label="Intent">
                  <Input
                    value={intentDraft.intent}
                    onChange={(event) =>
                      setIntentDraft({ ...intentDraft, intent: event.currentTarget.value })
                    }
                    className="h-9 text-sm"
                  />
                </LabeledField>
                <LabeledField label="Desired outcome">
                  <Input
                    value={intentDraft.desiredOutcome}
                    onChange={(event) =>
                      setIntentDraft({ ...intentDraft, desiredOutcome: event.currentTarget.value })
                    }
                    className="h-9 text-sm"
                  />
                </LabeledField>
                <LabeledField label="Acceptance criteria (one per line)">
                  <Textarea
                    value={intentDraft.acceptanceCriteria}
                    onChange={(event) =>
                      setIntentDraft({
                        ...intentDraft,
                        acceptanceCriteria: event.currentTarget.value,
                      })
                    }
                    className="min-h-20 text-sm"
                  />
                </LabeledField>
                <LabeledField label="Constraints (one per line)">
                  <Textarea
                    value={intentDraft.constraints}
                    onChange={(event) =>
                      setIntentDraft({ ...intentDraft, constraints: event.currentTarget.value })
                    }
                    className="min-h-20 text-sm"
                  />
                </LabeledField>
                <LabeledField label="Non-goals (one per line)">
                  <Textarea
                    value={intentDraft.nonGoals}
                    onChange={(event) =>
                      setIntentDraft({ ...intentDraft, nonGoals: event.currentTarget.value })
                    }
                    className="min-h-20 text-sm"
                  />
                </LabeledField>
                <LabeledField label="Open decisions (one per line)">
                  <Textarea
                    value={intentDraft.openDecisions}
                    onChange={(event) =>
                      setIntentDraft({ ...intentDraft, openDecisions: event.currentTarget.value })
                    }
                    className="min-h-20 text-sm"
                  />
                </LabeledField>
              </div>

              <div className="grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-2">
                <LabeledField label="Dependencies (one card id per line)">
                  <Textarea
                    value={detailDraft.dependencies}
                    onChange={(event) =>
                      setDetailDraft({ ...detailDraft, dependencies: event.currentTarget.value })
                    }
                    className="min-h-20 text-sm"
                  />
                </LabeledField>
                <LabeledField label="Conflicts with (one card id per line)">
                  <Textarea
                    value={detailDraft.conflictsWith}
                    onChange={(event) =>
                      setDetailDraft({ ...detailDraft, conflictsWith: event.currentTarget.value })
                    }
                    className="min-h-20 text-sm"
                  />
                </LabeledField>
                <LabeledField label="Parallel safe">
                  <Select
                    value={detailDraft.parallelismSafe}
                    onValueChange={(value) =>
                      setDetailDraft({
                        ...detailDraft,
                        parallelismSafe: value as DetailDraft["parallelismSafe"],
                      })
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue>{detailDraft.parallelismSafe}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {PARALLELISM_SAFETY_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </LabeledField>
                <LabeledField label="Parallelism reason">
                  <Input
                    value={detailDraft.parallelismReason}
                    onChange={(event) =>
                      setDetailDraft({
                        ...detailDraft,
                        parallelismReason: event.currentTarget.value,
                      })
                    }
                    className="h-9 text-sm"
                  />
                </LabeledField>
                <LabeledField label="Allowed write scopes (one per line)">
                  <Textarea
                    value={detailDraft.allowedWriteScopes}
                    onChange={(event) =>
                      setDetailDraft({
                        ...detailDraft,
                        allowedWriteScopes: event.currentTarget.value,
                      })
                    }
                    className="min-h-20 text-sm"
                  />
                </LabeledField>
              </div>
            </DialogPanel>
            <DialogFooter>
              {/* In the footer, not the panel: the panel scrolls, so an error
                  rendered next to the field would sit off-screen. */}
              {error ? (
                <p className="text-[12px] text-rose-300 sm:mr-auto sm:self-center">{error}</p>
              ) : null}
              {card.state === "Ready" ? (
                <Button variant="secondary" onClick={() => onRunCard(card)} disabled={busy}>
                  <PlayIcon className="size-3.5" />
                  Run
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={busy}>
                Save card
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
});
