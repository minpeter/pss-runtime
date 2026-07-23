import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../agent/core/agent";
import { createCallbackModel } from "../testing/test-fixtures";
import { collect } from "../thread/handle/test-support";
import type { AgentEvent } from "../thread/protocol/events";
import { definePlugin } from "./api";

describe("turn error plugin metadata", () => {
  it("observes the same structured provider error as the event stream", async () => {
    let observed: Extract<AgentEvent, { type: "turn-error" }> | undefined;
    const plugin = definePlugin((pss) => {
      pss.on("turn.error", (event) => {
        observed = event;
      });
    });
    const providerError = new APICallError({
      isRetryable: false,
      message: "Access denied",
      requestBodyValues: {},
      responseHeaders: { "x-request-id": "plugin-request" },
      statusCode: 403,
      url: "https://provider.example/v1/chat/completions",
    });
    const agent = await createAgent({
      model: createCallbackModel(() => Promise.reject(providerError)),
      plugins: [plugin],
    });

    const events = await collect(await agent.send("fail"));
    const turnError = events.at(-1);

    expect(observed).toEqual(turnError);
    expect(observed).toEqual({
      error: {
        category: "permission",
        correlationIds: [{ source: "x-request-id", value: "plugin-request" }],
        observedRetryable: false,
        status: 403,
        version: 1,
      },
      message: "The provider refused this request.",
      type: "turn-error",
    });
  });
});
