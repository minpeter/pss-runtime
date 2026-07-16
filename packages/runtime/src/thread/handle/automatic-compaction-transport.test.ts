import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  createStreamingMockLanguageModelV4,
  mockLanguageModelV4StreamText,
} from "../../testing/mock-language-model-v4-test-utils";
import { waitForModelCalls } from "./automatic-compaction.test-support";
import { collect } from "./test-support";

describe("Agent automatic compaction llmTransport", () => {
  it("summarizes over stream-collect when the agent opts into it", async () => {
    let calls = 0;
    const model = createStreamingMockLanguageModelV4(() => {
      calls += 1;
      if (calls === 1) {
        return mockLanguageModelV4StreamText("old done");
      }
      if (calls === 2) {
        return mockLanguageModelV4StreamText("tail done");
      }
      return mockLanguageModelV4StreamText("old exchange summarized");
    });
    const agent = new Agent({
      autoCompaction: { minMessages: 4, retainMessages: 2 },
      llmTransport: "stream-collect",
      model,
    });
    const thread = agent.thread("stream-auto");

    await collect(await thread.send("old"));
    await collect(await thread.send("tail"));
    await waitForModelCalls(() => calls, 3);

    // Turn steps and the background compaction summary all went through
    // streamText; the generate transport was never used.
    expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(3);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
