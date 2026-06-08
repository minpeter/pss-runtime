import { describe, expect, it } from "vitest";
import { backgroundNotificationKey } from "./subagent-background-test-support";

describe("subagent background test support", () => {
  it("builds stable background notification keys when task ids arrive out of order", () => {
    expect(backgroundNotificationKey("bg_2", "bg_1")).toBe(
      "background-complete:default:bg_1,bg_2"
    );
  });
});
