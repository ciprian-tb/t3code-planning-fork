import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AgentBoardCard,
  AgentBoardCardId,
  AgentBoardClaimResult,
  AgentBoardFile,
  AgentBoardState,
  EnvironmentId,
} from "@t3tools/contracts";
import { AGENT_BOARD_RELATIVE_PATH } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  GitBranchIcon,
  KanbanSquareIcon,
  LoaderIcon,
  RefreshCwIcon,
  Table2Icon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { AgentBoardCardDialog } from "./AgentBoardCardDialog";
import { AgentBoardDependencyTree } from "./AgentBoardDependencyTree";
import { AgentBoardKanban } from "./AgentBoardKanban";
import { AgentBoardTable } from "./AgentBoardTable";
import {
  addCard,
  buildExecutionTree,
  cardWithState,
  isBoardConflictError,
  newCardForState,
  runCardError,
  updateCard,
} from "./agentBoardModel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

const VIEWS = [
  { id: "kanban", label: "Kanban", icon: KanbanSquareIcon },
  { id: "table", label: "Planning table", icon: Table2Icon },
  { id: "tree", label: "Dependency tree", icon: GitBranchIcon },
] as const;

type BoardView = (typeof VIEWS)[number]["id"];

export interface AgentBoardPanelProps {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | undefined;
  /**
   * Task 7 wires the actual agent launch here; the panel only claims the card
   * and adopts whatever board the launcher hands back.
   */
  readonly onRunClaimedCard?: (result: AgentBoardClaimResult) => Promise<AgentBoardFile>;
  readonly className?: string;
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const AgentBoardPanel = memo(function AgentBoardPanel({
  environmentId,
  workspaceRoot,
  onRunClaimedCard,
  className,
}: AgentBoardPanelProps) {
  if (!workspaceRoot) {
    return (
      <div className={cn("flex min-h-0 flex-1 items-center justify-center p-6", className)}>
        <p className="text-[13px] text-muted-foreground/55">
          Open a project workspace to load its planning board.
        </p>
      </div>
    );
  }
  return (
    <AgentBoardPanelContent
      environmentId={environmentId}
      workspaceRoot={workspaceRoot}
      {...(onRunClaimedCard ? { onRunClaimedCard } : {})}
      {...(className ? { className } : {})}
    />
  );
});

function AgentBoardPanelContent({
  environmentId,
  workspaceRoot,
  onRunClaimedCard,
  className,
}: AgentBoardPanelProps & { readonly workspaceRoot: string }) {
  const boardAtom = useMemo(
    () =>
      projectEnvironment.loadAgentBoard({
        environmentId,
        input: { cwd: workspaceRoot, createIfMissing: true },
      }),
    [environmentId, workspaceRoot],
  );
  const boardResult = useAtomValue(boardAtom);
  const refreshBoard = useAtomRefresh(boardAtom);
  const saveAgentBoard = useAtomCommand(projectEnvironment.saveAgentBoard, {
    reportFailure: false,
  });
  const claimAgentBoardCard = useAtomCommand(projectEnvironment.claimAgentBoardCard, {
    reportFailure: false,
  });

  const loadedBoard = Option.getOrNull(AsyncResult.value(boardResult))?.board ?? null;
  const [adoptedBoard, setAdoptedBoard] = useState<AgentBoardFile | null>(null);
  const [lastLoadedBoard, setLastLoadedBoard] = useState<AgentBoardFile | null>(loadedBoard);
  const [view, setView] = useState<BoardView>("kanban");
  const [selectedCardId, setSelectedCardId] = useState<AgentBoardCardId | null>(null);
  const [openCardId, setOpenCardId] = useState<AgentBoardCardId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh server load wins over the locally adopted board — except while a
  // save is in flight. The board a poll lands with mid-save predates that save,
  // so adopting it would blink the user's own edit away and back again.
  if (loadedBoard !== lastLoadedBoard) {
    setLastLoadedBoard(loadedBoard);
    if (!busy) setAdoptedBoard(null);
  }

  const board = adoptedBoard ?? loadedBoard;
  const cards = board?.cards ?? [];
  const openCard = cards.find((card) => card.id === openCardId) ?? null;
  const executionRows = useMemo(() => (board ? buildExecutionTree(board) : []), [board]);
  const loadError =
    boardResult._tag === "Failure"
      ? failureMessage(Cause.squash(boardResult.cause), "Could not load board.")
      : null;

  // Every save ships the whole board, so it has to say which board it was
  // derived from: the one on screen before this edit, never `nextBoard`, whose
  // `updatedAt` the edit has already stamped. Without it a save made while the
  // runner works reverts the runner's transitions on every other card.
  const expectedUpdatedAt = board?.updatedAt;
  const commitBoard = useCallback(
    (nextBoard: AgentBoardFile) => {
      setAdoptedBoard(nextBoard);
      setBusy(true);
      setError(null);
      void (async () => {
        const result = await saveAgentBoard({
          environmentId,
          input: {
            cwd: workspaceRoot,
            board: nextBoard,
            ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
          },
        });
        setBusy(false);
        if (result._tag === "Success") {
          setAdoptedBoard(result.value.board);
          return;
        }
        if (isAtomCommandInterrupted(result)) return;
        const failure = failureMessage(squashAtomCommandFailure(result), "Could not save board.");
        if (isBoardConflictError(failure)) {
          // The edit is gone either way; reload so the retry starts from the
          // board the runner actually left behind.
          setAdoptedBoard(null);
          refreshBoard();
          const description =
            "The board changed while you were editing; your change was not saved. Try again.";
          setError(description);
          toastManager.add(
            stackedThreadToast({ type: "error", title: "Board changed", description }),
          );
          return;
        }
        setError(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Board save failed",
            description: failure,
          }),
        );
      })();
    },
    [environmentId, expectedUpdatedAt, refreshBoard, saveAgentBoard, workspaceRoot],
  );

  const editCard = useCallback(
    (cardId: AgentBoardCardId, updater: (card: AgentBoardCard) => AgentBoardCard) => {
      if (!board) return;
      commitBoard(updateCard(board, cardId, updater));
    },
    [board, commitBoard],
  );

  const moveCard = useCallback(
    (cardId: AgentBoardCardId, state: AgentBoardState) => {
      const timestamp = new Date().toISOString();
      editCard(cardId, (card) => cardWithState(card, state, timestamp));
    },
    [editCard],
  );

  const createCard = useCallback(
    (title: string, state: AgentBoardState) => {
      if (!board) return;
      const card = newCardForState(title, state);
      commitBoard(addCard(board, card));
      setSelectedCardId(card.id);
    },
    [board, commitBoard],
  );

  const runCard = useCallback(
    (card: AgentBoardCard) => {
      if (!board) return;
      const refusal = runCardError(card, board);
      if (refusal) {
        setError(refusal);
        return;
      }
      setBusy(true);
      setError(null);
      void (async () => {
        const result = await claimAgentBoardCard({
          environmentId,
          input: { cwd: workspaceRoot, cardId: card.id },
        });
        if (result._tag !== "Success") {
          setBusy(false);
          if (isAtomCommandInterrupted(result)) return;
          const description = failureMessage(
            squashAtomCommandFailure(result),
            "Could not claim board card.",
          );
          setError(description);
          toastManager.add(
            stackedThreadToast({ type: "error", title: "Claim failed", description }),
          );
          refreshBoard();
          return;
        }

        try {
          const launchedBoard = await onRunClaimedCard?.(result.value);
          setAdoptedBoard(launchedBoard ?? result.value.board);
          setSelectedCardId(result.value.card.id);
          toastManager.add({
            type: "success",
            // The launcher opens a worktree thread and loads the card's prompt
            // into its composer; the turn starts when the user sends it.
            title: onRunClaimedCard ? "Card handed to a thread" : "Workspace claimed",
            description: onRunClaimedCard
              ? `${result.value.card.title} is ready to send in its own worktree.`
              : result.value.workspacePath,
          });
        } catch (runError) {
          const description = failureMessage(runError, "Could not start the claimed card.");
          setAdoptedBoard(result.value.board);
          setError(description);
          toastManager.add(stackedThreadToast({ type: "error", title: "Run failed", description }));
        } finally {
          setBusy(false);
        }
      })();
    },
    [board, claimAgentBoardCard, environmentId, onRunClaimedCard, refreshBoard, workspaceRoot],
  );

  const openCardDetails = useCallback((card: AgentBoardCard) => {
    setSelectedCardId(card.id);
    setOpenCardId(card.id);
  }, []);

  const message = error ?? loadError;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-card/50", className)}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="secondary"
            className="rounded-md bg-emerald-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-emerald-300 uppercase"
          >
            Board
          </Badge>
          <span className="truncate text-[11px] text-muted-foreground/60">
            {AGENT_BOARD_RELATIVE_PATH}
          </span>
          <div
            role="tablist"
            aria-label="Board view"
            className="ml-2 flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/20 p-0.5"
          >
            {VIEWS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={view === entry.id}
                onClick={() => setView(entry.id)}
                className={cn(
                  "flex h-6 items-center gap-1 rounded-[5px] px-2 text-[11px] font-medium transition-colors",
                  view === entry.id
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-card/50 hover:text-foreground",
                )}
              >
                <entry.icon className="size-3.5" />
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => refreshBoard()}
          disabled={boardResult.waiting}
          aria-label="Refresh board"
          className="text-muted-foreground/50 hover:text-foreground/70"
        >
          <RefreshCwIcon className={cn("size-3.5", boardResult.waiting && "animate-spin")} />
        </Button>
      </div>

      {message ? (
        <p className="shrink-0 border-b border-rose-500/20 bg-rose-500/5 px-3 py-2 text-[11px] leading-4 text-rose-300">
          {message}
        </p>
      ) : null}

      {!board ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground/50">
          <LoaderIcon className="size-3.5 animate-spin" />
          Loading board
        </div>
      ) : view === "kanban" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <AgentBoardKanban
            cards={cards}
            selectedCardId={selectedCardId}
            busy={busy}
            onSelectCard={setSelectedCardId}
            onOpenCard={openCardDetails}
            onMoveCard={moveCard}
            onAddCard={createCard}
            onRunCard={runCard}
          />
        </div>
      ) : view === "table" ? (
        <AgentBoardTable
          cards={cards}
          busy={busy}
          onOpenCard={openCardDetails}
          onRunCard={runCard}
          onUpdateCard={editCard}
          onMoveCard={moveCard}
          onAddCard={(title) => createCard(title, "Draft")}
        />
      ) : (
        <AgentBoardDependencyTree rows={executionRows} onOpenCard={openCardDetails} />
      )}

      <AgentBoardCardDialog
        card={openCard}
        busy={busy}
        onOpenChange={(open) => {
          if (!open) setOpenCardId(null);
        }}
        // Keep the stamp `updateCard` applies; the draft was built pre-stamp.
        onSave={(next) => editCard(next.id, (card) => ({ ...next, updatedAt: card.updatedAt }))}
        onMoveCard={(card, state) => moveCard(card.id, state)}
        onRunCard={runCard}
      />
    </div>
  );
}

export default AgentBoardPanel;
