import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";

export function AgentBoardModelPicker({
  environmentId,
  value,
  projectDefault,
  disabled,
  onChange,
}: {
  environmentId: EnvironmentId;
  value: ModelSelection | null;
  projectDefault: ModelSelection | null;
  disabled: boolean;
  onChange: (selection: ModelSelection | null) => void;
}) {
  const configAtom = useMemo(
    () => serverEnvironment.configValueAtom(environmentId),
    [environmentId],
  );
  const config = useAtomValue(configAtom);
  const clientSettings = useClientSettings();
  const navigate = useNavigate();
  const settings = { ...(config?.settings ?? DEFAULT_SERVER_SETTINGS), ...clientSettings };
  const providers = config?.providers ?? EMPTY_SERVER_PROVIDERS;
  const inheritedSelection = projectDefault ?? config?.settings.defaultModelSelection ?? null;
  const selection =
    value ?? inheritedSelection ?? resolveDefaultProviderModelSelection(providers, null);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium text-muted-foreground">Agent and model</p>
      <div className="flex flex-wrap items-center gap-2">
        {selection ? (
          <ProviderModelPicker
            activeInstanceId={selection.instanceId}
            model={selection.model}
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={modelOptions}
            disabled={disabled}
            triggerVariant="outline"
            triggerAriaLabel="Task agent and model"
            onInstanceModelChange={(instanceId, model) =>
              onChange(createModelSelection(instanceId, model))
            }
            onOpenProviderSetup={(instanceId) =>
              void navigate({
                to: "/settings/providers",
                search: { environmentId, instanceId },
              })
            }
          />
        ) : null}
        {value ? (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>
            Use project default
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {inheritedSelection
              ? "Using project default"
              : "No default configured; choose an agent and model"}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() =>
            void navigate({
              to: "/settings/providers",
              search: { environmentId },
            })
          }
        >
          Configure agents
        </Button>
      </div>
      {disabled ? (
        <p className="text-xs text-muted-foreground">
          Agent selection is locked while this task is running.
        </p>
      ) : null}
    </div>
  );
}
