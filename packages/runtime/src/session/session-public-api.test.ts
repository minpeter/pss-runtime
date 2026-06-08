import { describe, expect, it } from "vitest";
import { Agent } from "../agent";

describe("SessionHandle public API", () => {
  it("does not expose session runs", () => {
    const session = new Agent({
      model: () => Promise.resolve([]),
    }).session("default");

    expect(getProperty(session, "runs")).toBeUndefined();
  });
});

function getProperty(value: unknown, property: "runs"): unknown {
  if (typeof value !== "object" || value === null) {
    return;
  }

  return property in value ? value[property] : undefined;
}
