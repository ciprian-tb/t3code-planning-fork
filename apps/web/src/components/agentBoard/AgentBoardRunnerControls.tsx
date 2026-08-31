import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { memo, useMemo, useState } from "react";

import { runnerStatusLine } from "./agentBoardModel";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

export interface AgentBoardRunnerControlsProps {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | undefined;
}

/**
 * The `Runner` switch and its one-line readout. Both directions live here: the
 * switch turns the board runner off as readily as on, and the line says what it
 * is doing right now so an operator never has to guess whether it is alive.
 */
export const AgentBoardRunnerControls = memo(function AgentBoardRunnerControls({
  environmentId,
  workspaceRoot,
}: AgentBoardRunnerControlsProps) {
  if (!workspaceRoot) return null;
  return <RunnerControls environmentId={environmentId} workspaceRoot={workspaceRoot} />;
});

function RunnerControls({
  environmentId,
  workspaceRoot,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  // The status family already refreshes itself every 5s while mounted, so the
  // readout stays fresh without a timer of our own.
  const statusAtom = useMemo(
    () =>
      projectEnvironment.getAgentBoardRunnerStatus({
        environmentId,
        input: { cwd: workspaceRoot },
      }),
    [environmentId, workspaceRoot],
  );
  const statusResult = useAtomValue(statusAtom);
  const refreshStatus = useAtomRefresh(statusAtom);
  const setRunnerEnabled = useAtomCommand(projectEnvironment.setAgentBoardRunnerEnabled, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);

  const status = Option.getOrUndefined(AsyncResult.value(statusResult));

  const toggle = (enabled: boolean) => {
    setBusy(true);
    void (async () => {
      const result = await setRunnerEnabled({
        environmentId,
        input: { cwd: workspaceRoot, enabled },
      });
      setBusy(false);
      refreshStatus();
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: enabled ? "Could not start the runner" : "Could not stop the runner",
          description: error instanceof Error ? error.message : "The board runner did not respond.",
        }),
      );
    })();
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span>Runner</span>
        <Switch
          checked={status?.enabled ?? false}
          disabled={busy || status === undefined}
          onCheckedChange={toggle}
          aria-label="Board runner"
          className="[--thumb-size:--spacing(3.5)]"
        />
      </label>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground/55">
        {status ? runnerStatusLine(status, Date.now()) : "runner status unavailable"}
      </span>
    </div>
  );
}
