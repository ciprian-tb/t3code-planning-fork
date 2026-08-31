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
 * Only the Planning route asks, so a chat route never gets yanked anywhere.
 */
export function resolvePlanningDestination<T>(input: {
  readonly disabled: boolean;
  readonly fallback: T;
}): T | undefined {
  return input.disabled ? input.fallback : undefined;
}
