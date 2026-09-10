import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, createAgent } from "@minpeter/pss-runtime";
import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleModelFromEnv } from "./model";
import { agentEventStreamParts } from "./tui/agent-event-stream";
import { BaseToolCallView } from "./tui/tool-call-view";
import { createWriteFileTool } from "./workspace-tools/write-file";

const theme = {
  heading: String,
  link: String,
  linkUrl: String,
  code: String,
  codeBlock: String,
  codeBlockBorder: String,
  quote: String,
  quoteBorder: String,
  hr: String,
  listBullet: String,
  bold: String,
  italic: String,
  strikethrough: String,
  underline: String,
};
const callId = "call_malformed_fixture";
const secret = "SOURCE_MUST_NOT_APPEAR_IN_ERROR";
const content = `preview-sentinel\n${'quote " slash \\ \uD83D\uDE80 \uD55C\n'.repeat(2500)}${secret}`;
const validInput = JSON.stringify({ path: "index.html", content });

function sse(input: string, finishReason: string | undefined): Response {
  const chunk = (delta: unknown, reason: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  let wire = chunk({
    tool_calls: [
      {
        index: 0,
        id: callId,
        type: "function",
        function: { name: "write_file", arguments: "" },
      },
    ],
  });
  // Individual UTF-16 code units split JSON escapes and surrogate pairs across deltas.
  for (let offset = 0; offset < input.length; offset += 127) {
    wire += chunk({
      tool_calls: [
        {
          index: 0,
          function: { arguments: input.slice(offset, offset + 127) },
        },
      ],
    });
  }
  if (finishReason !== undefined) {
    wire += chunk({}, finishReason);
    wire += "data: [DONE]\n\n";
  }
  const bytes = new TextEncoder().encode(wire);
  return new Response(
    new ReadableStream({
      start(controller) {
        // Byte boundaries split UTF-8 as well as SSE records.
        for (let offset = 0; offset < bytes.length; offset += 101) {
          controller.enqueue(bytes.slice(offset, offset + 101));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}

async function run(
  input: string,
  finishReason: string | undefined,
  executionError?: string
) {
  const workspace = await mkdtemp(join(tmpdir(), "pss-invalid-json-"));
  await writeFile(join(workspace, "index.html"), "original");
  const definition = createWriteFileTool(workspace);
  const execute = vi.fn(definition.execute);
  if (executionError !== undefined) {
    execute.mockImplementation(() => {
      const error = new Error(
        executionError.replace("AI_InvalidToolInputError: ", "")
      );
      error.name = "AI_InvalidToolInputError";
      throw error;
    });
  }
  const fetch = vi.fn<typeof globalThis.fetch>();
  fetch.mockResolvedValueOnce(sse(input, finishReason));
  fetch.mockResolvedValueOnce(
    new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } }
    )
  );
  const agent = await createAgent({
    model: createOpenAICompatibleModelFromEnv({
      fetch,
      runtimeEnv: {
        AI_API_KEY: "fixture",
        AI_BASE_URL: "https://fixture.invalid/v1",
        AI_MODEL: "fixture-model",
      },
    }),
    tools: { write_file: { ...definition, execute } },
  });
  try {
    const turn = await agent.thread("invalid-json").send("Run the fixture.");
    const events: AgentEvent[] = [];
    for await (const event of turn.events()) {
      events.push(event);
    }
    return {
      events,
      execute,
      requests: fetch.mock.calls.map(([, init]) =>
        JSON.parse(String(init?.body))
      ),
      bytes: await readFile(join(workspace, "index.html")),
      files: await readdir(workspace),
    };
  } finally {
    await agent.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
}

async function render(events: AgentEvent[]) {
  const view = new BaseToolCallView(callId, "write_file", theme);
  try {
    async function* stream() {
      yield* events;
    }
    for await (const part of agentEventStreamParts(stream())) {
      if (part.type === "tool-input-delta") {
        await view.appendInputChunk(String(part.inputTextDelta));
      }
      if (part.type === "tool-call") {
        view.setFinalInput(part.input);
      }
      if (part.type === "tool-error") {
        view.setError(part.error);
      }
    }
    return view.render(120).join("\n");
  } finally {
    view.dispose();
  }
}

describe("malformed tool JSON through runtime and TUI", () => {
  it.each([
    { name: "truncated", input: validInput.slice(0, -2), finish: "length" },
    {
      name: "malformed quote",
      input: validInput.replace("preview-sentinel", 'preview-sentinel"broken'),
      finish: "tool_calls",
    },
  ])(
    "rejects $name without writing and gives the next model bounded feedback",
    async ({ input, finish }) => {
      const result = await run(input, finish);
      expect(result.execute).not.toHaveBeenCalled();
      expect(result.bytes.toString()).toBe("original");
      expect(result.files).toEqual(["index.html"]);
      expect(result.requests).toHaveLength(2);
      const toolMessage = result.requests[1].messages.find(
        (message: { role: string }) => message.role === "tool"
      );
      const feedback = JSON.parse(toolMessage.content);
      expect(feedback).toMatchObject({
        code: "INVALID_TOOL_ARGUMENTS",
        kind: "json-parse",
        inputCharacters: input.length,
      });
      expect(feedback.finishReason).toBe(
        finish === "length" ? "length" : undefined
      );
      expect(feedback.message.length).toBeGreaterThan(40);
      expect(toolMessage.content.length).toBeLessThan(700);
      expect(toolMessage.content).not.toContain(secret);
      const event = result.events.find((event) => event.type === "tool-result");
      expect(event).toMatchObject({
        output: { type: "error-json", value: feedback },
      });
      expect(
        result.events.filter((event) => event.type === "model-retry")
      ).toEqual([]);
      expect(result.events.at(-1)?.type).toBe("turn-end");
      const output = await render(result.events);
      expect(output).toContain("preview-sentinel");
      expect(output).toContain("INVALID_TOOL_ARGUMENTS");
      expect(output).toContain(secret);
      expect(output.length).toBeLessThan(6000);
    }
  );

  it("identifies schema rejection without claiming malformed JSON", async () => {
    const input = JSON.stringify({ path: "index.html" });
    const result = await run(input, "tool_calls");
    expect(result.execute).not.toHaveBeenCalled();
    expect(result.bytes.toString()).toBe("original");
    const toolMessage = result.requests[1].messages.find(
      (message: { role: string }) => message.role === "tool"
    );
    expect(JSON.parse(toolMessage.content)).toMatchObject({
      code: "INVALID_TOOL_ARGUMENTS",
      kind: "schema-validation",
      inputCharacters: input.length,
    });
  });

  it("preserves an executed tool error resembling SDK validation feedback", async () => {
    const error = "AI_InvalidToolInputError: fixture executor failure";
    const result = await run(validInput, "tool_calls", error);
    expect(result.execute).toHaveBeenCalledOnce();
    const toolMessage = result.requests[1].messages.find(
      (message: { role: string }) => message.role === "tool"
    );
    expect(toolMessage.content).toBe(error);
    expect(
      result.events.find((event) => event.type === "tool-result")
    ).toMatchObject({
      output: { type: "error-text", value: error },
    });
  });

  it("writes valid large JSON once with exact decoded bytes", async () => {
    expect(validInput.length).toBeGreaterThan(30_000);
    const result = await run(validInput, "tool_calls");
    expect(result.execute).toHaveBeenCalledOnce();
    expect(result.bytes).toEqual(Buffer.from(content));
    expect(
      result.events.filter((event) => event.type === "turn-error")
    ).toEqual([]);
  });

  it("does not execute an incomplete call on abrupt stream closure", async () => {
    const result = await run(validInput.slice(0, -2), undefined);
    expect(result.execute).not.toHaveBeenCalled();
    expect(result.bytes.toString()).toBe("original");
    expect(result.files).toEqual(["index.html"]);
    expect(result.requests).toHaveLength(1);
    expect(result.events.at(-1)?.type).toBe("turn-error");
    expect(
      result.events.filter((event) => event.type === "model-retry")
    ).toEqual([
      {
        attempt: 1,
        attemptId: expect.any(String),
        phase: "stopped",
        reason: "stream-ended",
        remainingRetries: 0,
        type: "model-retry",
      },
    ]);
  });
});
