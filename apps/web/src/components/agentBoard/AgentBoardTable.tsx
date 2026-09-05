import type { AgentBoardCard, AgentBoardCardId, AgentBoardState } from "@t3tools/contracts";
import { PencilIcon, PlayIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
  MOVABLE_STATES,
  cardWithPlanningField,
  sortCardsForTable,
  stateBadgeVariant,
} from "./agentBoardModel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

type TableColumn = "area" | "slice" | "card" | "status" | "priority" | "slicePlan" | "actions";
type EditableColumn = Exclude<TableColumn, "status" | "actions">;

const COLUMNS: ReadonlyArray<{ id: TableColumn; label: string; minWidth: number; width: number }> =
  [
    { id: "area", label: "Area", minWidth: 120, width: 170 },
    { id: "slice", label: "Slice", minWidth: 140, width: 180 },
    { id: "card", label: "Card", minWidth: 220, width: 460 },
    { id: "status", label: "Status", minWidth: 120, width: 132 },
    { id: "priority", label: "Priority", minWidth: 76, width: 86 },
    { id: "slicePlan", label: "Slice plan", minWidth: 140, width: 170 },
    { id: "actions", label: "Actions", minWidth: 92, width: 104 },
  ];

const DEFAULT_WIDTHS = Object.fromEntries(
  COLUMNS.map((column) => [column.id, column.width]),
) as Record<TableColumn, number>;

interface AgentBoardTableProps {
  readonly cards: readonly AgentBoardCard[];
  readonly busy: boolean;
  readonly onOpenCard: (card: AgentBoardCard) => void;
  readonly onRunCard: (card: AgentBoardCard) => void;
  readonly onUpdateCard: (
    cardId: AgentBoardCardId,
    updater: (card: AgentBoardCard) => AgentBoardCard,
  ) => void;
  readonly onMoveCard: (cardId: AgentBoardCardId, state: AgentBoardState) => void;
  readonly onAddCard: (title: string) => void;
}

/**
 * Column widths and in-flight cell text stay local: they are presentation
 * state, and lifting them would re-render the whole panel on every keystroke.
 */
export const AgentBoardTable = memo(function AgentBoardTable({
  cards,
  busy,
  onOpenCard,
  onRunCard,
  onUpdateCard,
  onMoveCard,
  onAddCard,
}: AgentBoardTableProps) {
  const [columnWidths, setColumnWidths] = useState<Record<TableColumn, number>>(DEFAULT_WIDTHS);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newTitle, setNewTitle] = useState("");

  const rows = useMemo(() => sortCardsForTable(cards), [cards]);
  const gridTemplate = COLUMNS.map((column) => `${columnWidths[column.id]}px`).join(" ");
  const minWidth = COLUMNS.reduce((total, column) => total + columnWidths[column.id], 24);

  const beginResize = (column: TableColumn, startX: number) => {
    const startWidth = columnWidths[column];
    const minColumnWidth = COLUMNS.find((entry) => entry.id === column)?.minWidth ?? 80;
    const handleMove = (event: PointerEvent) => {
      setColumnWidths((widths) => ({
        ...widths,
        [column]: Math.max(minColumnWidth, startWidth + event.clientX - startX),
      }));
    };
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const draftKey = (cardId: AgentBoardCardId, column: EditableColumn) => `${cardId}:${column}`;

  const cellValue = (card: AgentBoardCard, column: EditableColumn): string => {
    const draft = drafts[draftKey(card.id, column)];
    if (draft !== undefined) return draft;
    switch (column) {
      case "area":
        return card.area ?? "";
      case "slice":
        return card.slice ?? "";
      case "card":
        return card.title;
      case "priority":
        return String(card.priority);
      case "slicePlan":
        return card.slicePlanPath ?? "";
    }
  };

  // ponytail: commit on blur/Enter rather than on a debounce timer — one save
  // per finished edit is enough, and there is no timer to leak.
  const commitCell = (card: AgentBoardCard, column: EditableColumn) => {
    const key = draftKey(card.id, column);
    const value = drafts[key];
    setDrafts((existing) => {
      if (!(key in existing)) return existing;
      const next = { ...existing };
      delete next[key];
      return next;
    });
    if (value === undefined) return;

    switch (column) {
      case "area":
      case "slice":
        onUpdateCard(card.id, (existing) => cardWithPlanningField(existing, column, value));
        return;
      case "slicePlan":
        onUpdateCard(card.id, (existing) =>
          cardWithPlanningField(existing, "slicePlanPath", value),
        );
        return;
      case "card": {
        const title = value.trim();
        if (title) onUpdateCard(card.id, (existing) => ({ ...existing, title }) as AgentBoardCard);
        return;
      }
      case "priority": {
        const priority = Number.parseInt(value, 10);
        if (Number.isFinite(priority) && priority >= 1) {
          onUpdateCard(card.id, (existing) => ({ ...existing, priority }) as AgentBoardCard);
        }
      }
    }
  };

  const editableCell = (
    card: AgentBoardCard,
    column: EditableColumn,
    extra?: { type?: "number"; placeholder?: string },
  ) => (
    <Input
      type={extra?.type}
      min={extra?.type === "number" ? 1 : undefined}
      placeholder={extra?.placeholder}
      value={cellValue(card, column)}
      aria-label={`${column} for ${card.title}`}
      onChange={(event) =>
        setDrafts((existing) => ({
          ...existing,
          [draftKey(card.id, column)]: event.currentTarget.value,
        }))
      }
      onBlur={() => commitCell(card, column)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className="h-8 min-w-0 rounded-none border-r-0 text-xs"
    />
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-background p-3">
      <div style={{ minWidth }}>
        <div
          className="grid items-center gap-0 border-b border-border/60 pb-1"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          {COLUMNS.map((column) => (
            <div key={column.id} className="relative flex items-center px-2">
              <span className="truncate text-[10px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
                {column.label}
              </span>
              {column.id === "actions" ? null : (
                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${column.label} column`}
                  className="absolute top-0 -right-1 h-5 w-2 cursor-col-resize"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    beginResize(column.id, event.clientX);
                  }}
                />
              )}
            </div>
          ))}
        </div>

        {rows.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-muted-foreground/45">No cards yet.</p>
        ) : null}

        <div className="mt-1 space-y-1">
          {rows.map((card) => (
            <div
              key={card.id}
              className="grid items-center"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {editableCell(card, "area", { placeholder: "Unassigned" })}
              {editableCell(card, "slice")}
              {editableCell(card, "card")}
              <Select
                value={card.state}
                onValueChange={(value) => onMoveCard(card.id, value as AgentBoardState)}
              >
                <SelectTrigger
                  size="xs"
                  className="h-8 min-w-0 rounded-none border-r-0"
                  aria-label={`State for ${card.title}`}
                >
                  <SelectValue>
                    <Badge size="sm" variant={stateBadgeVariant(card.state)}>
                      {card.state}
                    </Badge>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {MOVABLE_STATES.map((state) => (
                    <SelectItem key={state} value={state}>
                      {state}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {editableCell(card, "priority", { type: "number" })}
              {editableCell(card, "slicePlan", { placeholder: "docs/agents/slices/..." })}
              <div className="flex h-8 min-w-0 items-center justify-end gap-1 overflow-hidden rounded-r-md border border-input px-1">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-6 text-muted-foreground/45 hover:text-foreground/80"
                  onClick={() => onOpenCard(card)}
                  aria-label={`Edit ${card.title}`}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
                {card.state === "Ready" ? (
                  <Button
                    size="xs"
                    className="h-6 px-1.5 text-[10px]"
                    onClick={() => onRunCard(card)}
                    disabled={busy}
                  >
                    <PlayIcon className="size-3" />
                    Run
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2 flex max-w-lg gap-2">
          <Input
            value={newTitle}
            onChange={(event) => setNewTitle(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !newTitle.trim()) return;
              onAddCard(newTitle.trim());
              setNewTitle("");
            }}
            placeholder="Add a draft card"
            className="h-8 text-xs"
          />
          <Button
            size="xs"
            variant="secondary"
            className="h-8 shrink-0 px-2 text-xs"
            disabled={busy || newTitle.trim().length === 0}
            onClick={() => {
              onAddCard(newTitle.trim());
              setNewTitle("");
            }}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  );
});
