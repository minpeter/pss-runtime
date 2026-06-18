import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createCallbackModel,
  sentUserMessage,
  sentUserText,
  userMessage,
  userText,
} from "../../testing/test-fixtures";
import { userTextToModelMessage } from "../protocol/mapping";
import { collect } from "./test-support";

describe("Agent session API", () => {
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
      { type: "assistant-text", text: "DONE" },
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

  it("rejects malformed explicit user-message input before queueing", async () => {
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await expect(
      agent.send({
        type: "user-message",
        content: [{ type: "file", data: "abc" }],
      } as never)
    ).rejects.toThrow(
      'Agent input content parts must be { type: "text", text }, { type: "image", image }, or { type: "file", data, mediaType }.'
    );
  });

  it("rejects explicit user-message content that is not an array", async () => {
    const agent = new Agent({
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await expect(
      agent.send({
        content: "not-content-parts",
        type: "user-message",
      } as never)
    ).rejects.toThrow(
      "Agent input must be text, text parts, content parts, user-text, or user-message."
    );
  });

  it("session.send accepts user-message events", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([]);
      }),
    });

    await collect(
      await agent.thread("custom").send(
        userMessage([
          { type: "text", text: "summarize" },
          { type: "image", image: "iVBORw0KGgo=" },
        ])
      )
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

  it("session.send accepts user-text events", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([]);
      }),
    });

    await collect(
      await agent.thread("custom").send({ type: "user-text", text: "hello" })
    );

    expect(seenHistory).toEqual([[userTextToModelMessage(userText("hello"))]]);
  });
});
