import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, useCanGoBack, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";

import { AgentBoardPanel } from "../components/agentBoard/AgentBoardPanel";
import { AgentBoardRunnerControls } from "../components/agentBoard/AgentBoardRunnerControls";
import { useRunAgentBoardCard } from "../components/agentBoard/useRunAgentBoardCard";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { useClientSettings } from "../hooks/useSettings";
import { getLatestThreadForProject } from "../lib/threadSort";
import { resolvePlanningDestination, usePlanningFeaturesDisabled } from "../planningFeaturesState";
import { useProject, useThreadShellsForProjectRefs } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

function PlanningRouteView() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const params = Route.useParams();
  const projectId = params.projectId as ProjectId;
  const projectRef = useMemo(
    () => scopeProjectRef(params.environmentId as EnvironmentId, projectId),
    [params.environmentId, projectId],
  );
  const projectRefs = useMemo(() => [projectRef], [projectRef]);
  const project = useProject(projectRef);
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const threadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const workspaceRoot = project?.workspaceRoot;
  const setRunnerEnabled = useAtomCommand(projectEnvironment.setAgentBoardRunnerEnabled, {
    reportFailure: false,
  });
  // Break is a stop button: leaving the runner driving agents on a surface the
  // operator just shut would make it a half-measure.
  const stopRunner = useCallback(async () => {
    if (!workspaceRoot) return;
    await setRunnerEnabled({
      environmentId: projectRef.environmentId,
      input: { cwd: workspaceRoot, enabled: false },
    });
  }, [projectRef.environmentId, setRunnerEnabled, workspaceRoot]);
  const [planningDisabled, togglePlanningDisabled] = usePlanningFeaturesDisabled(stopRunner);
  const runClaimedCard = useRunAgentBoardCard(projectRef, workspaceRoot);

  // Landing spot when there is no history entry to return to (direct URL, or a
  // forced exit): the project's own most recent thread, ranked exactly as the
  // sidebar ranks it, so we never drop the user into some other project's work.
  const exitToChat = useCallback(
    (replace: boolean) => {
      const latest = getLatestThreadForProject(threads, projectId, threadSortOrder);
      void (latest
        ? navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: latest.environmentId, threadId: latest.id },
            replace,
          })
        : navigate({ to: "/", replace }));
    },
    [navigate, projectId, threadSortOrder, threads],
  );

  // A user-initiated `Back to chat` is ordinary history back, so it returns to
  // wherever they actually came from and leaves Planning in the history.
  const backToChat = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    exitToChat(false);
  }, [canGoBack, exitToChat]);

  // Break replaces the Planning history entry so browser Back cannot walk back
  // onto a surface the operator just disabled.
  const forcedExit = useCallback(() => exitToChat(true), [exitToChat]);
  const forcedDestination = resolvePlanningDestination({
    disabled: planningDisabled,
    fallback: forcedExit,
  });
  useEffect(() => {
    forcedDestination?.();
  }, [forcedDestination]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border/70 bg-background px-3 sm:px-5">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="gap-1.5 px-2 text-[11px]"
          onClick={backToChat}
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to chat
        </Button>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground/55">
          {project?.title ?? "Planning"}
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {planningDisabled ? null : (
            <AgentBoardRunnerControls
              environmentId={projectRef.environmentId}
              workspaceRoot={workspaceRoot}
            />
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-amber-200"
            onClick={togglePlanningDisabled}
            title="Break glass: disable Planning features and return to chat"
          >
            <TriangleAlertIcon className="size-3.5" />
            Break
          </Button>
        </div>
      </div>
      {/* The redirect above is a passive effect, so it runs a commit too late to
          stop the board's `createIfMissing` subscription from writing
          `.t3/agent-board.json` into a project whose Planning was broken. The
          switch is read synchronously (useSyncExternalStore), so not rendering
          the panel keeps it unmounted from the very first commit. */}
      {planningDisabled ? null : (
        <AgentBoardPanel
          projectDefault={project?.defaultModelSelection ?? null}
          environmentId={projectRef.environmentId}
          workspaceRoot={workspaceRoot}
          onRunClaimedCard={runClaimedCard}
        />
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/planning/$environmentId/$projectId")({
  component: PlanningRouteView,
});
