import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentBoardWorkflowConfig, DEFAULT_AGENT_BOARD_WORKFLOW } from "./agentBoardWorkflow.ts";

const decodeWorkflow = Schema.decodeUnknownSync(AgentBoardWorkflowConfig);

describe("AgentBoardWorkflowConfig", () => {
  it("fills every default from an empty object", () => {
    const config = decodeWorkflow({});
    expect(config).toEqual(DEFAULT_AGENT_BOARD_WORKFLOW);
    expect(config.polling.intervalMs).toBe(15_000);
    expect(config.agent.maxConcurrentAgents).toBe(1);
    expect(config.agent.onSuccess).toBe("Review");
  });

  it("maps snake_case front matter keys", () => {
    const config = decodeWorkflow({
      polling: { interval_ms: 2000 },
      agent: { max_concurrent_agents: 2, review_agent: "none", on_success: "Done" },
    });
    expect(config.polling.intervalMs).toBe(2000);
    expect(config.agent.maxConcurrentAgents).toBe(2);
    expect(config.agent.reviewAgent).toBe("none");
    expect(config.agent.onSuccess).toBe("Done");
  });

  it("rejects a non-local tracker and out-of-range polling", () => {
    expect(() => decodeWorkflow({ tracker: { kind: "linear" } })).toThrow();
    expect(() => decodeWorkflow({ polling: { interval_ms: 10 } })).toThrow();
  });

  it("ignores unknown Symphony keys", () => {
    const config = decodeWorkflow({
      hooks: { after_create: "echo hi" },
      codex: { command: "codex app-server" },
    });
    expect(config.agent.maxTurns).toBe(20);
  });
});
