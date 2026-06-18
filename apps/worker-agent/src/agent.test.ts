import type { AgentEvent, AgentRun } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";

import { collectAssistantText, WORKER_AGENT_INSTRUCTIONS } from "./agent";

describe("worker-agent instructions", () => {
  it("uses Apex as the assistant name", () => {
    expect(WORKER_AGENT_INSTRUCTIONS).toContain("You are Apex");
    expect(WORKER_AGENT_INSTRUCTIONS).not.toContain("POKE");
  });

  it("includes Bori-inspired texting style instructions without unsupported execution surfaces", () => {
    const requiredRules = [
      "warm but never flattering",
      "witty only when it fits",
      "No preamble",
      "Match the user's texting style",
      "Do not send emoji unless the user used emoji first",
      "Treat the newest human user message as the source of truth",
      "Use earlier conversation only as context",
      "Do not adapt to non-user messages",
      "If the user is just chatting, do not turn the reply into a help offer",
      "When the user is upset or asks why something went wrong",
      "focus on what the user experienced",
      "Some messaging platforms can make replies less natural",
      "Do not invent product facts, security claims, launch details, prices, or URLs",
      "Do not mention internal agents, tools, or implementation details",
      "Avoid botty phrases",
    ] as const;

    for (const rule of requiredRules) {
      expect(WORKER_AGENT_INSTRUCTIONS).toContain(rule);
    }

    const excludedSurfaces = [
      "sendmessageto_agent",
      "subagent",
      "display_draft",
      "draftId",
      "emailId",
      "<block>",
      "reacttomessage",
      "querymedia",
      "wait tool",
    ] as const;

    for (const surface of excludedSurfaces) {
      expect(WORKER_AGENT_INSTRUCTIONS.toLowerCase()).not.toContain(
        surface.toLowerCase()
      );
    }
  });
});

describe("collectAssistantText", () => {
  it("joins assistant text events", async () => {
    await expect(
      collectAssistantText(
        runWithEvents([
          { type: "assistant-text", text: "first" },
          { type: "assistant-text", text: "second" },
        ])
      )
    ).resolves.toBe("first\nsecond");
  });

  it("rejects when the run contains a turn-error without assistant text", async () => {
    await expect(
      collectAssistantText(
        runWithEvents([{ type: "turn-error", message: "model unavailable" }])
      )
    ).rejects.toThrow("model unavailable");
  });

  it("rejects when a turn-error follows assistant text", async () => {
    await expect(
      collectAssistantText(
        runWithEvents([
          { type: "assistant-text", text: "partial" },
          { type: "turn-error", message: "tool failed" },
        ])
      )
    ).rejects.toThrow("tool failed");
  });
});

function runWithEvents(events: readonly AgentEvent[]): AgentRun {
  return {
    events: () => eventStream(events),
  };
}

async function* eventStream(
  events: readonly AgentEvent[]
): AsyncIterable<AgentEvent> {
  yield* events;
}
