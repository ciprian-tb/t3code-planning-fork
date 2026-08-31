/**
 * The manual half of the agent board launch sequence: what the Run button does
 * with a card the server has already claimed. It is the client-side twin of
 * `AgentBoardRunner.launch` (`apps/server/src/agentBoard/AgentBoardRunner.ts`)
 * and deliberately reuses the same prompt builders, the same worktree layout,
 * and the same board transitions so a card looks identical whether a human or
 * the runner started it.
 *
 * The one thing this must never skip is writing `implementationRunId` back to
 * the card. `claim` sets `Running` without it, and the runner reads a `Running`
 * card with no run id as ownerless — it re-claims the workspace and starts its
 * own agent in the worktree this run just reserved.
 *
 * @module useRunAgentBoardCard
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  RuntimeSessionId,
  type AgentBoardClaimResult,
  type AgentBoardFile,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { buildImplementationPrompt } from "@t3tools/shared/agentBoardPrompts";
import { useCallback } from "react";

import { cardWithLaunchFailure, cardWithLaunchedRun, updateCard } from "./agentBoardModel";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

function asError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(String(cause ?? "") || fallback);
}

/**
 * Opens a worktree-backed thread for a claimed card and leaves the card's
 * implementation prompt in its composer. The returned board is the saved one,
 * so the panel adopts what the server actually holds.
 */
export function useRunAgentBoardCard(
  projectRef: ScopedProjectRef,
  workspaceRoot: string | undefined,
) {
  const newThread = useNewThreadHandler();
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const saveAgentBoard = useAtomCommand(projectEnvironment.saveAgentBoard, {
    reportFailure: false,
  });

  return useCallback(
    async (claim: AgentBoardClaimResult): Promise<AgentBoardFile> => {
      if (!workspaceRoot) throw new Error("Open a project workspace before running a card.");
      const { environmentId } = projectRef;

      const saveBoard = async (board: AgentBoardFile): Promise<AgentBoardFile> => {
        const saved = await saveAgentBoard({
          environmentId,
          input: { cwd: workspaceRoot, board },
        });
        if (saved._tag !== "Success") {
          throw asError(squashAtomCommandFailure(saved), "Could not save the board.");
        }
        return saved.value.board;
      };

      // The claim reserved `.t3/workspaces/<card>` relative to the project
      // root; the branch is derived from that same segment so the worktree
      // directory and the branch can never disagree about the card id.
      const workspacePath = `${workspaceRoot.replace(/\/+$/, "")}/${claim.workspacePath}`;
      const branchName =
        claim.card.runtime.branchName ??
        `agent-board/${claim.workspacePath.slice(claim.workspacePath.lastIndexOf("/") + 1)}`;

      let threadId: RuntimeSessionId | undefined;
      try {
        // ponytail: no reuse check — a second run of a card whose worktree
        // still exists fails here with git's own message and parks the card.
        // Add an "is this already a worktree" probe if that retry gets common.
        const created = await createWorktree({
          environmentId,
          input: {
            cwd: workspaceRoot,
            refName: "HEAD",
            newRefName: branchName,
            path: workspacePath,
          },
        });
        if (created._tag !== "Success") {
          throw asError(squashAtomCommandFailure(created), "Could not create the card worktree.");
        }
        const branch = created.value.worktree.refName;

        const session = await newThread(projectRef, { worktreePath: workspacePath, branch });
        if (session === null) throw new Error("Could not open a thread for this card.");
        const runId = RuntimeSessionId.make(session.threadId);
        threadId = runId;
        useComposerDraftStore
          .getState()
          .setPrompt(session.draftId, buildImplementationPrompt(claim.card));

        const now = new Date().toISOString();
        return await saveBoard(
          updateCard(
            claim.board,
            claim.card.id,
            (card) => cardWithLaunchedRun(card, { threadId: runId, branchName: branch }, now),
            now,
          ),
        );
      } catch (cause) {
        const failure = asError(cause, "Could not start the claimed card.");
        // Best effort: if this save fails too the board file itself is
        // unwritable, and the claim stands until the user retries.
        const now = new Date().toISOString();
        await saveBoard(
          updateCard(
            claim.board,
            claim.card.id,
            (card) =>
              cardWithLaunchFailure(
                card,
                { error: failure.message, ...(threadId ? { threadId } : {}) },
                now,
              ),
            now,
          ),
        ).catch(() => undefined);
        throw failure;
      }
    },
    [createWorktree, newThread, projectRef, saveAgentBoard, workspaceRoot],
  );
}
