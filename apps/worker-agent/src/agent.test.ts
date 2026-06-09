import { describe, expect, it } from "vitest";

import { WORKER_AGENT_INSTRUCTIONS } from "./agent";

describe("worker-agent instructions", () => {
  it("includes Bori-inspired texting style instructions without execution-delegation rules", () => {
    const requiredRules = [
      "warm but never flattering",
      "witty only when it fits",
      "concise",
      "no canned intro or sign-off",
      "Match the user's texting style",
      "Do not send emoji unless the user used emoji first",
      "Do not mention internal agents, tools, or implementation details",
      "Avoid botty phrases",
    ] as const;

    for (const rule of requiredRules) {
      expect(WORKER_AGENT_INSTRUCTIONS).toContain(rule);
    }

    const excludedSurfaces = [
      "sendmessageto_agent",
      "subagent",
      "delegate",
      "display_draft",
      "membership",
      "bouncer",
      "calendar",
      "emailId",
      "memory",
    ] as const;

    for (const surface of excludedSurfaces) {
      expect(WORKER_AGENT_INSTRUCTIONS.toLowerCase()).not.toContain(
        surface.toLowerCase()
      );
    }
  });
});
