import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";

import { AgentBoardPanel } from "../components/agentBoard/AgentBoardPanel";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import {
  resolvePlanningDestination,
  selectMostRecentThreadRef,
  usePlanningFeaturesDisabled,
} from "../planningFeaturesState";
import { useProject, useThreadShellsForProjectRefs } from "../state/entities";

function PlanningRouteView() {
  const navigate = useNavigate();
  const params = Route.useParams();
  const projectRef = useMemo(
    () => scopeProjectRef(params.environmentId as EnvironmentId, params.projectId as ProjectId),
    [params.environmentId, params.projectId],
  );
  const projectRefs = useMemo(() => [projectRef], [projectRef]);
  const project = useProject(projectRef);
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const [planningDisabled, togglePlanningDisabled] = usePlanningFeaturesDisabled();

  // Leaving Planning lands on the project's own most recent thread when it has
  // one, so `Back to chat` is a return and not a trip to the chat index.
  const backToChat = useCallback(() => {
    const threadRef = selectMostRecentThreadRef(threads);
    void (threadRef
      ? navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
          replace: true,
        })
      : navigate({ to: "/", replace: true }));
  }, [navigate, threads]);

  const forcedExit = resolvePlanningDestination({
    disabled: planningDisabled,
    current: "planning",
    fallback: backToChat,
  });
  useEffect(() => {
    forcedExit?.();
  }, [forcedExit]);

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
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="ml-auto gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-amber-200"
          onClick={togglePlanningDisabled}
          title="Break glass: disable Planning features and return to chat"
        >
          <TriangleAlertIcon className="size-3.5" />
          Break
        </Button>
      </div>
      <AgentBoardPanel
        environmentId={projectRef.environmentId}
        workspaceRoot={project?.workspaceRoot}
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/planning/$environmentId/$projectId")({
  component: PlanningRouteView,
});
