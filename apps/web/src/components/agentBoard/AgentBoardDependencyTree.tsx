import type { AgentBoardCard } from "@t3tools/contracts";
import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react";
import { memo } from "react";

import type { ExecutionTreeRow } from "./agentBoardModel";
import { stateBadgeVariant } from "./agentBoardModel";
import { Badge } from "../ui/badge";

interface AgentBoardDependencyTreeProps {
  readonly rows: readonly ExecutionTreeRow[];
  readonly onOpenCard: (card: AgentBoardCard) => void;
}

/**
 * Renders the flat execution-path rows produced by `buildExecutionTree`. The
 * model already resolved tiers and cycles, so this view never walks the graph
 * itself — a cycle shows up as a marked row instead of a hung render.
 */
export const AgentBoardDependencyTree = memo(function AgentBoardDependencyTree({
  rows,
  onOpenCard,
}: AgentBoardDependencyTreeProps) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-background p-4">
      <div className="mb-3">
        <p className="text-[11px] font-semibold tracking-widest text-emerald-400 uppercase">
          Dependency tree
        </p>
        <p className="text-[12px] text-muted-foreground/60">
          Read-only execution order. Edit cards, slices, and dependencies in Kanban or Planning
          table.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="flex min-h-[320px] items-center justify-center rounded-md border border-border/60 text-[13px] text-muted-foreground/55">
          No cards yet.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            if (row.kind === "section") {
              return (
                <p
                  key={row.key}
                  className="pt-4 text-[10px] font-semibold tracking-widest text-muted-foreground/55 uppercase"
                >
                  {row.label}
                </p>
              );
            }

            if (row.kind === "tier") {
              return (
                <div key={row.key} className="flex items-center gap-3 pt-3">
                  <div className="h-px flex-1 bg-emerald-300/15" />
                  <span className="rounded-full border border-emerald-500/25 bg-background px-3 py-1 text-[10px] font-semibold tracking-widest text-emerald-200/75 uppercase">
                    {row.label}
                  </span>
                  <div className="h-px flex-1 bg-emerald-300/15" />
                </div>
              );
            }

            if (row.kind === "cycle") {
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => onOpenCard(row.card)}
                  className="flex w-full items-start gap-2 rounded-md border border-rose-500/35 bg-rose-500/5 px-3 py-2 text-left"
                >
                  <RotateCcwIcon className="mt-0.5 size-3.5 shrink-0 text-rose-300" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-foreground/90">
                      {row.card.title}
                    </p>
                    <p className="mt-0.5 text-[11px] text-rose-200/80">
                      Dependency cycle
                      {row.cycleWith.length > 0 ? ` with ${row.cycleWith.join(", ")}` : ""}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {row.cardId}
                  </Badge>
                </button>
              );
            }

            return (
              <button
                key={row.key}
                type="button"
                onClick={() => onOpenCard(row.card)}
                className="flex w-full items-start gap-2 rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-left transition-colors hover:border-emerald-400/35"
                style={{ marginLeft: row.depth * 16 }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge size="sm" variant={stateBadgeVariant(row.card.state)}>
                      {row.card.state}
                    </Badge>
                    <span className="truncate text-[10px] text-muted-foreground/45">
                      {row.cardId}
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[12px] leading-4 font-medium">
                    {row.card.title}
                  </p>
                  {row.missingDependencyIds.length > 0 ? (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-200/80">
                      <AlertTriangleIcon className="size-3 shrink-0" />
                      Missing dependencies: {row.missingDependencyIds.join(", ")}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground/45">
                  P{row.card.priority}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
