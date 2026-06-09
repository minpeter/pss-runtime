import { describe, expect, it } from "vitest";

import { parseAgentRequest } from "./agent-do";

describe("AgentDurableObject request parsing", () => {
  it("trims valid text payloads", async () => {
    await expect(
      parseAgentRequest(
        new Request("https://agent.internal/turn", {
          body: JSON.stringify({ text: " hello " }),
          method: "POST",
        })
      )
    ).resolves.toEqual({ text: "hello" });
  });

  it("rejects invalid JSON as missing text", async () => {
    await expect(
      parseAgentRequest(
        new Request("https://agent.internal/turn", {
          body: "{",
          method: "POST",
        })
      )
    ).resolves.toBeUndefined();
  });

  it("rejects non-string text payloads", async () => {
    await expect(
      parseAgentRequest(
        new Request("https://agent.internal/turn", {
          body: JSON.stringify({ text: 1 }),
          method: "POST",
        })
      )
    ).resolves.toBeUndefined();
  });
});
