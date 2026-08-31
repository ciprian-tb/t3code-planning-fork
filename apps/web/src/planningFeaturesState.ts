import * as Schema from "effect/Schema";

import { useLocalStorage } from "./hooks/useLocalStorage";

/**
 * Break-glass switch for the Planning surface. Persisted so an operator who
 * pulled the handle stays out of Planning across reloads.
 */
const PLANNING_FEATURES_DISABLED_KEY = "t3code.planningFeaturesDisabled";

/**
 * What one press of `Break` does. Pulling the handle must also stop the board
 * runner, or agents keep working on a surface the operator just shut. Releasing
 * it only reopens Planning: whether agents may run again is a separate decision
 * the operator makes with the `Runner` switch.
 */
export function nextPlanningBreakState(disabled: boolean): {
  readonly disabled: boolean;
  readonly stopRunner: boolean;
} {
  return { disabled: !disabled, stopRunner: !disabled };
}

/**
 * Reads the break-glass switch and returns a toggle for the `Break` control.
 * The switch only gates Planning entry points; it never touches the provider
 * `interactionMode`, so releasing it restores the route exactly as it was.
 *
 * `stopRunner` is awaited before the flag flips, because flipping it unmounts
 * the Planning route and would interrupt an in-flight request. Failures are
 * swallowed: a dead server must never trap the operator on a surface they are
 * trying to shut down.
 */
export function usePlanningFeaturesDisabled(
  stopRunner?: () => Promise<unknown>,
): readonly [disabled: boolean, toggle: () => void] {
  const [disabled, setDisabled] = useLocalStorage(
    PLANNING_FEATURES_DISABLED_KEY,
    false,
    Schema.Boolean,
  );
  const next = nextPlanningBreakState(disabled);
  return [
    disabled,
    () => {
      void (async () => {
        if (next.stopRunner && stopRunner) {
          try {
            await stopRunner();
          } catch {
            /* best effort */
          }
        }
        setDisabled(next.disabled);
      })();
    },
  ] as const;
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
