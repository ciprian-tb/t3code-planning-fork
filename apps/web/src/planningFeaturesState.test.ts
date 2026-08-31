import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePlanningDestination, selectMostRecentThreadRef } from "./planningFeaturesState";

const environmentId = "env-1" as EnvironmentId;

function thread(id: string, updatedAt: string, archivedAt: string | null = null) {
  return { id: id as ThreadId, environmentId, updatedAt, archivedAt };
}

describe("resolvePlanningDestination", () => {
  it("disabling planning forces the route back to chat", () => {
    expect(resolvePlanningDestination({ disabled: true, current: "planning", fallback: "/" })).toBe(
      "/",
    );
  });

  it("restores access to planning once the break switch is released", () => {
    expect(
      resolvePlanningDestination({ disabled: false, current: "planning", fallback: "/" }),
    ).toBeUndefined();
  });

  it("leaves someone already on chat where they are", () => {
    expect(
      resolvePlanningDestination({ disabled: true, current: "chat", fallback: "/" }),
    ).toBeUndefined();
  });
});

describe("selectMostRecentThreadRef", () => {
  it("picks the most recently updated thread as the exit target", () => {
    expect(
      selectMostRecentThreadRef([
        thread("older", "2026-08-29T10:00:00.000Z"),
        thread("newest", "2026-08-30T10:00:00.000Z"),
        thread("middle", "2026-08-29T23:00:00.000Z"),
      ]),
    ).toEqual({ environmentId, threadId: "newest" });
  });

  it("never exits into an archived thread", () => {
    expect(
      selectMostRecentThreadRef([
        thread("live", "2026-08-29T10:00:00.000Z"),
        thread("archived", "2026-08-30T10:00:00.000Z", "2026-08-30T11:00:00.000Z"),
      ]),
    ).toEqual({ environmentId, threadId: "live" });
  });

  it("returns null when the project has no thread to fall back to", () => {
    expect(selectMostRecentThreadRef([])).toBeNull();
    expect(
      selectMostRecentThreadRef([
        thread("archived", "2026-08-30T10:00:00.000Z", "2026-08-30T11:00:00.000Z"),
      ]),
    ).toBeNull();
  });
});
