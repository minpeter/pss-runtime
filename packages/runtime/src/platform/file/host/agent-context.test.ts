import { describe, expect, it } from "vitest";
import { Agent, createAgent } from "../../../agent/core/agent";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../../testing/mock-language-model-v4-test-utils";
import { createNodeFileAgentContext } from "./agent-context";

describe("createNodeFileAgentContext", () => {
  it("accepts the public asynchronous agent factory", async () => {
    const directories: string[] = [];
    const context = createNodeFileAgentContext({
      createAgent: async ({ directory, host }) => {
        directories.push(directory);
        return await createAgent({
          host,
          model: createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]),
        });
      },
      directory: ".pss-test",
    });

    await expect(context.agent()).resolves.toBeInstanceOf(Agent);
    expect(directories).toEqual([".pss-test"]);
  });
});
