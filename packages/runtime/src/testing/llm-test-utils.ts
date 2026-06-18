import type { Tool, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { expect, vi } from "vitest";
import type { ModelGenerationOptions, ModelStepOptions } from "../llm/llm";
import type { AgentEvent } from "../session/protocol/events";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Empty,
} from "./mock-language-model-v4-test-utils";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();

  return {
    ...actual,
    generateText: generateTextMock,
  };
});

export const fakeModel = createMockLanguageModelV4([
  mockLanguageModelV4Empty(),
]);

export function getGenerateTextMock() {
  return generateTextMock;
}

export const createNoopTool = () =>
  tool({
    description: "No-op test tool.",
    execute: () => ({}),
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    outputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
  });

export async function loadModelStepRunner() {
  const { generateModelStep } = await import("../llm/llm");
  return (
    options: ModelGenerationOptions,
    context: Pick<ModelStepOptions, "history" | "signal" | "toolExecution">
  ) => generateModelStep({ ...options, ...context });
}

export async function loadAgent() {
  const { Agent } = await import("../agent/core/agent");
  return Agent;
}

export async function drainRun(run: { events(): AsyncIterable<unknown> }) {
  for await (const _event of run.events()) {
    // Drain the run so model calls complete before assertions.
  }
}

export async function collectRun(run: { events(): AsyncIterable<AgentEvent> }) {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

export function lastGenerateTextTools(): ToolSet {
  const call = generateTextMock.mock.calls.at(-1)?.[0] as
    | { tools?: ToolSet }
    | undefined;
  return call?.tools ?? {};
}

export function executableTool(tools: ToolSet, name: string): Tool {
  const candidate = tools[name];
  expect(candidate).toBeDefined();
  expect(candidate?.execute).toBeTypeOf("function");
  return candidate as Tool;
}

export function toolExecutionOptions(signal = new AbortController().signal) {
  return {
    abortSignal: signal,
    context: undefined,
    messages: [],
    toolCallId: "call-1",
  };
}
