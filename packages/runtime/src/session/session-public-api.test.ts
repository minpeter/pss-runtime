import { describe, expect, it } from "vitest";
import { Agent } from "../agent";

describe("SessionHandle public API", () => {
  it("does not expose session runs", () => {
    const session = new Agent({
      model: () => Promise.resolve([]),
    }).session("default");

    expect(getProperty(session, "runs")).toBeUndefined();
  });

  it("exposes dispose instead of kill", () => {
    const session = new Agent({
      model: () => Promise.resolve([]),
    }).session("default");

    expect(getProperty(session, "dispose")).toBeTypeOf("function");
    expect(getProperty(session, "kill")).toBeUndefined();
  });
});

function getProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null) {
    return;
  }

  return property in value ? Reflect.get(value, property) : undefined;
}
