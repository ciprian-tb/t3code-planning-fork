import type { AgentBoardCard, AgentBoardCardId, AgentBoardState } from "@t3tools/contracts";
import { CheckCircle2Icon, CircleDotIcon, PencilIcon, PlayIcon, PlusIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState, type DragEvent } from "react";

import {
  BOARD_COLUMNS,
  MOVABLE_STATES,
  cardRuntimeSummary,
  stateBadgeVariant,
} from "./agentBoardModel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "~/lib/utils";

const COLUMN_MIN_WIDTH = 260;

interface AgentBoardKanbanProps {
  readonly cards: readonly AgentBoardCard[];
  readonly selectedCardId: AgentBoardCardId | null;
  readonly busy: boolean;
  readonly onSelectCard: (cardId: AgentBoardCardId) => void;
  readonly onOpenCard: (card: AgentBoardCard) => void;
  readonly onMoveCard: (cardId: AgentBoardCardId, state: AgentBoardState) => void;
  readonly onAddCard: (title: string, state: AgentBoardState) => void;
  readonly onRunCard: (card: AgentBoardCard) => void;
}

/** Drag state is view-local: nothing outside the board cares which card is mid-drag. */
export const AgentBoardKanban = memo(function AgentBoardKanban({
  cards,
  selectedCardId,
  busy,
  onSelectCard,
  onOpenCard,
  onMoveCard,
  onAddCard,
  onRunCard,
}: AgentBoardKanbanProps) {
  const [draggingCardId, setDraggingCardId] = useState<AgentBoardCardId | null>(null);
  const [dragOverState, setDragOverState] = useState<AgentBoardState | null>(null);
  const [quickAddState, setQuickAddState] = useState<AgentBoardState | null>(null);
  const [quickAddTitle, setQuickAddTitle] = useState("");

  const columns = useMemo(
    () =>
      BOARD_COLUMNS.map((column) => ({
        ...column,
        cards: cards.filter((card) => card.state === column.state),
      })),
    [cards],
  );

  // One second-hand for every backoff countdown on the board, and only while a
  // card is actually waiting one out — nothing repaints on an idle board.
  const hasBackoff = cards.some((card) => card.runtime.nextRetryAt !== undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasBackoff) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasBackoff]);

  const openQuickAdd = (state: AgentBoardState) => {
    setQuickAddState(state);
    setQuickAddTitle("");
  };

  const submitQuickAdd = (state: AgentBoardState) => {
    const title = quickAddTitle.trim();
    if (!title) return;
    onAddCard(title, state);
    setQuickAddTitle("");
    setQuickAddState(null);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>, state: AgentBoardState) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverState(state);
  };

  return (
    <div
      className="grid min-h-full grid-flow-col gap-3 p-3"
      style={{
        boxSizing: "border-box",
        gridTemplateColumns: `repeat(${columns.length}, minmax(${COLUMN_MIN_WIDTH}px, 1fr))`,
        minWidth: columns.length * COLUMN_MIN_WIDTH,
      }}
    >
      {columns.map((column) => (
        <section
          key={column.state}
          onDragOver={(event) => handleDragOver(event, column.state)}
          onDragLeave={() => setDragOverState((state) => (state === column.state ? null : state))}
          onDrop={(event) => {
            event.preventDefault();
            if (draggingCardId) onMoveCard(draggingCardId, column.state);
            setDraggingCardId(null);
            setDragOverState(null);
          }}
          className={cn(
            "flex min-h-[520px] flex-col space-y-2 rounded-md border border-border/60 bg-muted/15 p-2",
            dragOverState === column.state && "border-emerald-500/45 bg-emerald-500/5",
          )}
        >
          <div className="flex h-8 items-center justify-between">
            <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
              {column.label}
            </p>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground/35">{column.cards.length}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-6 text-muted-foreground/45 hover:text-foreground/80"
                onClick={() => openQuickAdd(column.state)}
                disabled={busy}
                aria-label={`Add card to ${column.label}`}
              >
                <PlusIcon className="size-3.5" />
              </Button>
            </div>
          </div>

          {quickAddState === column.state ? (
            <div className="rounded-md border border-border/70 bg-background/70 p-2">
              <Input
                autoFocus
                value={quickAddTitle}
                onChange={(event) => setQuickAddTitle(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitQuickAdd(column.state);
                  if (event.key === "Escape") setQuickAddState(null);
                }}
                placeholder={`Add ${column.label.toLowerCase()} card`}
                className="h-8 text-xs"
              />
              <div className="mt-2 flex gap-1.5">
                <Button
                  size="xs"
                  className="h-7 px-2 text-xs"
                  onClick={() => submitQuickAdd(column.state)}
                  disabled={busy || quickAddTitle.trim().length === 0}
                >
                  Add
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setQuickAddState(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 space-y-1.5">
            {column.cards.map((card) => {
              const runtime = cardRuntimeSummary(card, now);
              return (
                <article
                  key={card.id}
                  draggable
                  className={cn(
                    "cursor-grab rounded-lg border bg-background/55 p-2.5 text-left transition-colors active:cursor-grabbing",
                    draggingCardId === card.id && "opacity-45",
                    selectedCardId === card.id
                      ? "border-emerald-500/40"
                      : "border-border/55 hover:border-border",
                  )}
                  onDragStart={(event) => {
                    setDraggingCardId(card.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", card.id);
                  }}
                  onDragEnd={() => {
                    setDraggingCardId(null);
                    setDragOverState(null);
                  }}
                  onClick={() => onSelectCard(card.id)}
                  onDoubleClick={() => onOpenCard(card)}
                >
                  <div className="flex min-w-0 items-start gap-2">
                    {card.state === "Done" ? (
                      <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
                    ) : (
                      <CircleDotIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/45" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-[13px] leading-4 text-foreground/90">
                        {card.title}
                      </p>
                      <p className="mt-1 truncate text-[10px] text-muted-foreground/35">
                        {card.id}
                      </p>
                    </div>
                  </div>
                  {runtime.phase || runtime.retryIn ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {runtime.phase ? (
                        <span className="rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {runtime.phase}
                        </span>
                      ) : null}
                      {runtime.retryIn ? (
                        <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                          {runtime.retryIn}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {runtime.question ? (
                    <p className="mt-1.5 line-clamp-2 text-[10px] leading-3.5 text-amber-200/85">
                      {runtime.question}
                    </p>
                  ) : null}
                  {runtime.error ? (
                    <p className="mt-1.5 line-clamp-1 text-[10px] leading-3.5 text-rose-300/85">
                      {runtime.error}
                    </p>
                  ) : null}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <Badge size="sm" variant={stateBadgeVariant(card.state)}>
                      {card.state}
                    </Badge>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-6 text-muted-foreground/45 hover:text-foreground/80"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenCard(card);
                        }}
                        aria-label={`Edit ${card.title}`}
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                      {card.state === "Ready" ? (
                        <Button
                          size="xs"
                          className="h-6 px-1.5 text-[10px]"
                          onClick={(event) => {
                            event.stopPropagation();
                            onRunCard(card);
                          }}
                          disabled={busy}
                        >
                          <PlayIcon className="size-3" />
                          Run
                        </Button>
                      ) : null}
                      <Select
                        value={card.state}
                        onValueChange={(value) => onMoveCard(card.id, value as AgentBoardState)}
                      >
                        <SelectTrigger
                          variant="ghost"
                          size="xs"
                          className="h-6 px-1.5 text-[10px]"
                          aria-label={`Move ${card.title}`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <SelectValue>Move</SelectValue>
                        </SelectTrigger>
                        <SelectPopup alignItemWithTrigger={false}>
                          {MOVABLE_STATES.map((state) => (
                            <SelectItem key={state} value={state} className="min-w-36">
                              {state}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                  </div>
                </article>
              );
            })}
            {column.cards.length === 0 && quickAddState !== column.state ? (
              <button
                type="button"
                className="flex h-28 w-full items-center justify-center rounded-md border border-dashed border-border/60 bg-background/25 text-[12px] text-muted-foreground/45 transition-colors hover:border-border hover:bg-background/45 hover:text-muted-foreground"
                onClick={() => openQuickAdd(column.state)}
              >
                Add a card
              </button>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
});
