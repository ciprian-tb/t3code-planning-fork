import { describe, expect, it } from "vite-plus/test";

import { resolvePlanningDestination } from "./planningFeaturesState";

describe("resolvePlanningDestination", () => {
  it("disabling planning forces the route back to chat", () => {
    expect(resolvePlanningDestination({ disabled: true, fallback: "/" })).toBe("/");
  });

  it("restores access to planning once the break switch is released", () => {
    expect(resolvePlanningDestination({ disabled: false, fallback: "/" })).toBeUndefined();
  });
});
