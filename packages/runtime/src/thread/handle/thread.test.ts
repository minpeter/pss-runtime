import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  overlayRuntimeInput,
  sentUserMessage,
  sentUserText,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import { collect } from "./test-support";

describe("Agent thread API", () => {
  it("agent.send accepts string input and streams one run", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });

    const events = await collect(await agent.send("hello"));

    expect(seenHistory).toEqual([[userTextToModelMessage(userText("hello"))]]);
    expect(events).toEqual([
      sentUserText("hello"),
      { type: "turn-start" },
      { type: "step-start" },
      { type: "assistant-output", text: "DONE" },
      { type: "step-end" },
      { type: "turn-end" },
    ]);
  });
  it("agent.send accepts multipart string input without lossy joining", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });

    const events = await collect(
      await agent.send(["context", "hello"] as const)
    );

    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText(["context", "hello"]))],
    ]);
    expect(events[0]).toEqual(sentUserText(["context", "hello"]));
  });

  it("agent.send accepts JSON-serializable user content parts", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });

    const input = [
      { type: "text", text: "describe this" },
      { type: "image", image: "iVBORw0KGgo=", mediaType: "image/png" },
      {
        type: "file",
        data: { type: "text", text: "inline document" },
        filename: "note.txt",
        mediaType: "text/plain",
      },
    ] as const;
    const events = await collect(await agent.send(input));

    expect(seenHistory).toEqual([
      [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "file", data: "iVBORw0KGgo=", mediaType: "image/png" },
            {
              type: "file",
              data: { type: "text", text: "inline document" },
              filename: "note.txt",
              mediaType: "text/plain",
            },
          ],
        },
      ],
    ]);
    expect(events[0]).toEqual(sentUserMessage(input));
  });

  it("rejects malformed multipart input before queueing", async () => {
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await expect(
      agent.send([{ type: "image", mediaType: "image/png" }] as never)
    ).rejects.toThrow(
      'Agent input content parts must be { type: "text", text }, { type: "image", image }, or { type: "file", data, mediaType }.'
    );
  });

  it("rejects sparse text arrays before queueing", async () => {
    const sparseInput = new Array<string>(1);
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await expect(agent.send(sparseInput)).rejects.toThrow(
      'Agent input content parts must be { type: "text", text }, { type: "image", image }, or { type: "file", data, mediaType }.'
    );
  });

  it("rejects malformed content parts before queueing", async () => {
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await expect(
      agent.send([{ type: "file", data: "abc" }] as never)
    ).rejects.toThrow(
      'Agent input content parts must be { type: "text", text }, { type: "image", image }, or { type: "file", data, mediaType }.'
    );
  });

  it("rejects explicit user input objects before queueing", async () => {
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await expect(
      agent.send({
        type: "user-input",
        text: "not-public-input",
      } as never)
    ).rejects.toThrow(
      "Agent input must be text, text parts, or content parts."
    );
  });

  it("thread.send accepts multipart content parts", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([]);
      }),
    });

    await collect(
      await agent.thread("custom").send([
        { type: "text", text: "summarize" },
        { type: "image", image: "iVBORw0KGgo=" },
      ])
    );

    expect(seenHistory).toEqual([
      [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize" },
            {
              type: "file",
              data: "iVBORw0KGgo=",
              filename: undefined,
              mediaType: "image/png",
              providerOptions: undefined,
            },
          ],
        },
      ],
    ]);
  });

  it("thread.send accepts text", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([]);
      }),
    });

    await collect(await agent.thread("custom").send("hello"));

    expect(seenHistory).toEqual([[userTextToModelMessage(userText("hello"))]]);
  });

  it("thread.overlay injects next-turn runtime context before send input", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });
    const thread = agent.thread("custom");

    const returned = thread.overlay("profile: warm tone");
    const events = await collect(
      await returned.overlay("locale: ko").send("hello")
    );

    expect(returned).toBe(thread);
    expect(eventTypes(events)).toEqual([
      "user-input",
      "turn-start",
      "runtime-input",
      "runtime-input",
      "step-start",
      "assistant-output",
      "step-end",
      "turn-end",
    ]);
    expect(events).toContainEqual(
      overlayRuntimeInput("profile: warm tone", "turn-start")
    );
    expect(events).toContainEqual(
      overlayRuntimeInput("locale: ko", "turn-start")
    );
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("profile: warm tone")),
        userTextToModelMessage(userText("locale: ko")),
        userTextToModelMessage(userText("hello")),
      ],
    ]);
  });
});
