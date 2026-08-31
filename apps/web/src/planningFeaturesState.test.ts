import { describe, expect, it } from "vite-plus/test";

import { nextPlanningBreakState, resolvePlanningDestination } from "./planningFeaturesState";

describe("resolvePlanningDestination", () => {
  it("disabling planning forces the route back to chat", () => {
    expect(resolvePlanningDestination({ disabled: true, fallback: "/" })).toBe("/");
  });

  it("restores access to planning once the break switch is released", () => {
    expect(resolvePlanningDestination({ disabled: false, fallback: "/" })).toBeUndefined();
  });
});

describe("nextPlanningBreakState", () => {
  it("pulling the handle disables planning and stops the board runner", () => {
    expect(nextPlanningBreakState(false)).toEqual({ disabled: true, stopRunner: true });
  });

  it("releasing the handle re-enables planning without touching the runner", () => {
    expect(nextPlanningBreakState(true)).toEqual({ disabled: false, stopRunner: false });
  });
});
