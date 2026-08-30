import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { WorkflowFile, WorkflowFileLive } from "./WorkflowFile.ts";

// `provideMerge` so the tests themselves can reach FileSystem/Path to build fixtures.
const layer = WorkflowFileLive.pipe(Layer.provideMerge(NodeServices.layer));

const withTempProject = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-board-workflow-" });
    for (const [name, content] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(root, name), content);
    }
    return root;
  });

describe("WorkflowFile", () => {
  it.effect("returns defaults when WORKFLOW.md is absent", () =>
    Effect.gen(function* () {
      const root = yield* withTempProject({});
      const loaded = yield* (yield* WorkflowFile).load(root);
      expect(loaded.source).toBe("defaults");
      expect(loaded.config.polling.intervalMs).toBe(15_000);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("parses front matter and keeps last-known-good after corruption", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* withTempProject({
        "WORKFLOW.md": "---\npolling:\n  interval_ms: 2000\n---\n# body\n",
      });
      const service = yield* WorkflowFile;
      const first = yield* service.load(root);
      expect(first.source).toBe("workflow-md");
      expect(first.config.polling.intervalMs).toBe(2000);

      yield* fs.writeFileString(path.join(root, "WORKFLOW.md"), "---\npolling: [\n---\n");
      const second = yield* service.load(root);
      expect(second.source).toBe("last-known-good");
      expect(second.config.polling.intervalMs).toBe(2000);
      expect(second.error).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("treats a file without front matter as defaults with no error", () =>
    Effect.gen(function* () {
      const root = yield* withTempProject({ "WORKFLOW.md": "# Just prose\n" });
      const loaded = yield* (yield* WorkflowFile).load(root);
      expect(loaded.source).toBe("workflow-md");
      expect(loaded.error).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
