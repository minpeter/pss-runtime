import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, isStreamAgentEvent } from "@minpeter/pss-runtime";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodingAgentExec } from "./exec";

type MockStreamResult = Extract<
  Exclude<
    NonNullable<
      ConstructorParameters<typeof MockLanguageModelV4>[0]
    >["doStream"],
    (...args: never[]) => unknown
  >,
  { readonly stream: unknown }
>;
type MockStreamPart =
  MockStreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: 4,
  },
  outputTokens: { reasoning: undefined, text: 2, total: 2 },
};

const streamChunks = [
  { type: "stream-start", warnings: [] },
  { id: "text-1", type: "text-start" },
  { delta: "hello ", id: "text-1", type: "text-delta" },
  { delta: "world", id: "text-1", type: "text-delta" },
  { id: "text-1", type: "text-end" },
  {
    finishReason: { raw: "stop", unified: "stop" },
    type: "finish",
    usage,
  },
] satisfies MockStreamPart[];

function createStreamingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [{ stream: convertArrayToReadableStream(streamChunks) }],
  });
}

function createCapturedOutput() {
  let buffer = "";
  return {
    lines(): readonly Record<string, unknown>[] {
      return buffer
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    output: {
      write(text: string) {
        buffer += text;
      },
    },
  };
}

describe("runCodingAgentExec", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "pss-exec-test-"));
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  it("streams delta events as NDJSON but excludes them from the result", async () => {
    const captured = createCapturedOutput();

    const result = await runCodingAgentExec({
      model: createStreamingModel(),
      prompt: "say hello",
      stdout: captured.output,
      workspace,
    });

    const lines = captured.lines();
    const metadata = lines.find((line) => line.type === "metadata");
    expect(metadata).toMatchObject({ schema: "pss-headless-v1" });

    const agentEvents = lines
      .filter((line) => line.type === "agent_event")
      .map((line) => line.event as AgentEvent);
    const deltaEvents = agentEvents.filter(
      (event) => event.type === "assistant-output-delta"
    );
    expect(deltaEvents).toEqual([
      expect.objectContaining({ text: "hello " }),
      expect.objectContaining({ text: "world" }),
    ]);
    expect(agentEvents.some((event) => isStreamAgentEvent(event))).toBe(true);

    const resultLine = lines.find((line) => line.type === "result");
    expect(resultLine).toBeDefined();
    const resultPayload = resultLine?.result as { events: AgentEvent[] };
    expect(
      resultPayload.events.some((event) => isStreamAgentEvent(event))
    ).toBe(false);

    expect(result.events.some((event) => isStreamAgentEvent(event))).toBe(
      false
    );
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("hello world");
  });
});
