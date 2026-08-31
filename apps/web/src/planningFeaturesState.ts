import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "./hooks/useLocalStorage";

/**
 * Break-glass switch for the Planning surface. Persisted so an operator who
 * pulled the handle stays out of Planning across reloads.
 */
const PLANNING_FEATURES_DISABLED_KEY = "t3code.planningFeaturesDisabled";

/**
 * Reads the break-glass switch and returns a toggle for the `Break` control.
 * The switch only gates Planning entry points; it never touches the provider
 * `interactionMode`, so releasing it restores the route exactly as it was.
 */
export function usePlanningFeaturesDisabled(): readonly [disabled: boolean, toggle: () => void] {
  const [disabled, setDisabled] = useLocalStorage(
    PLANNING_FEATURES_DISABLED_KEY,
    false,
    Schema.Boolean,
  );
  return [disabled, () => setDisabled((previous) => !previous)] as const;
}

/**
 * Where the Planning route has to send the user, or `undefined` to stay put.
 * Only someone standing on Planning while the switch is pulled gets moved:
 * flipping the switch from a chat route must not yank them anywhere.
 */
export function resolvePlanningDestination<T>(input: {
  readonly disabled: boolean;
  readonly current: "planning" | "chat";
  readonly fallback: T;
}): T | undefined {
  return input.disabled && input.current === "planning" ? input.fallback : undefined;
}

/**
 * The project's most recently updated live thread, used as the Planning exit
 * target. Archived threads are not somewhere we can drop a user.
 */
export function selectMostRecentThreadRef(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
  }>,
): ScopedThreadRef | null {
  let latest: (typeof threads)[number] | null = null;
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    if (latest === null || thread.updatedAt > latest.updatedAt) {
      latest = thread;
    }
  }
  return latest === null ? null : { environmentId: latest.environmentId, threadId: latest.id };
}
