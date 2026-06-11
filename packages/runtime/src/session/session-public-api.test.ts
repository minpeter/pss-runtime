import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../mock-language-model-v4-test-utils";
import { collect } from "./session.test-support";

const testFixturesSourceUrl = new URL("../test-fixtures.ts", import.meta.url);

describe("SessionHandle public API", () => {
  it("does not expose session runs", () => {
    const session = new Agent({
      model: createMockLanguageModelV4([mockLanguageModelV4Text("done")]),
    }).session("default");

    expect(getProperty(session, "runs")).toBeUndefined();
  });

  it("exposes dispose instead of kill", () => {
    const session = new Agent({
      model: createMockLanguageModelV4([mockLanguageModelV4Text("done")]),
    }).session("default");

    expect(getProperty(session, "dispose")).toBeTypeOf("function");
    expect(getProperty(session, "kill")).toBeUndefined();
  });

  it("drives session runs with MockLanguageModelV4 and records model calls", async () => {
    const model = createMockLanguageModelV4([
      mockLanguageModelV4Text("mocked reply"),
    ]);
    const agent = new Agent({ model });

    const events = await collect(await agent.session("mock-v4").send("hello"));

    expect(events).toContainEqual({
      text: "mocked reply",
      type: "assistant-text",
    });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("hello");
  });

  it("does not keep runtime LLM fixtures once MockLanguageModelV4 helpers exist", async () => {
    const source = await readFile(testFixturesSourceUrl, "utf8");

    expect(source).not.toContain(["create", "Scripted", "Llm"].join(""));
    expect(source).not.toContain(["Runtime", "Llm"].join(""));
  });
});

function getProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null) {
    return;
  }

  return property in value ? Reflect.get(value, property) : undefined;
}
