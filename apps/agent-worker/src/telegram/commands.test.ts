import { describe, expect, it } from "vitest";
import {
  matchesDebugResetCommand,
  matchesHelpCommand,
  matchesTelegramCommand,
} from "./commands";

describe("telegram command matching", () => {
  it("matches help and start with optional bot suffix", () => {
    expect(matchesHelpCommand("/help")).toBe(true);
    expect(matchesHelpCommand("/start")).toBe(true);
    expect(matchesHelpCommand("/help@pss_agent")).toBe(true);
    expect(matchesHelpCommand("/start args")).toBe(true);
    expect(matchesHelpCommand("/helpful")).toBe(false);
  });

  it("matches debug_reset", () => {
    expect(matchesDebugResetCommand("/debug_reset")).toBe(true);
    expect(matchesDebugResetCommand("/debug_reset@pss_agent")).toBe(true);
    expect(matchesTelegramCommand("/debug_resetful", "debug_reset")).toBe(
      false
    );
  });
});
