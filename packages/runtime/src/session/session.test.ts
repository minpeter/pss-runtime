import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import {
  assistantMessage,
  eventTypes,
  userMessage,
  userText,
} from "../test-fixtures";
import { userTextToModelMessage } from "./mapping";
import { collect } from "./session.test-support";

describe("Agent session API", () => {
  it("agent.send accepts string input and streams one run", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });

    const events = await collect(await agent.send("hello"));

    expect(seenHistory).toEqual([[userTextToModelMessage(userText("hello"))]]);
    expect(events).toEqual([
      { type: "user-text", text: "hello" },
      { type: "turn-start" },
      { type: "step-start" },
      { type: "assistant-text", text: "DONE" },
      { type: "step-end" },
      { type: "turn-end" },
    ]);
  });

  it("calls turn hooks around a queued turn", async () => {
    const hookCalls: string[] = [];
    const agent = new Agent({
      hooks: {
        afterTurn: ({ history, input, result }) => {
          hookCalls.push(`${input.type}:after:${result}:${history.length}`);
        },
        beforeTurn: ({ history, input }) => {
          hookCalls.push(`${input.type}:before:${history.length}`);
        },
      },
      llm: () => Promise.resolve([assistantMessage("DONE")]),
    });

    const events = await collect(await agent.send("hello"));

    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(hookCalls).toEqual([
      "user-text:before:0",
      "user-text:after:completed:2",
    ]);
  });

  it("commits successful output before afterTurn failures", async () => {
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      hooks: {
        afterTurn: () => {
          throw new Error("after turn failed");
        },
      },
      llm: ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage(`DONE ${calls}`)]);
      },
    });

    const firstEvents = await collect(
      await agent.session("after-turn").send("first")
    );
    const secondEvents = await collect(
      await agent.session("after-turn").send("second")
    );

    expect(eventTypes(firstEvents)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(eventTypes(secondEvents)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("first")),
      assistantMessage("DONE 1"),
      userTextToModelMessage(userText("second")),
    ]);
  });

  it("agent.send accepts multipart string input without lossy joining", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });

    const events = await collect(
      await agent.send(["context", "hello"] as const)
    );

    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText(["context", "hello"]))],
    ]);
    expect(events[0]).toEqual({
      type: "user-text",
      text: ["context", "hello"],
    });
  });

  it("agent.send accepts JSON-serializable user content parts", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
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
    expect(events[0]).toEqual({
      type: "user-message",
      content: input,
    });
  });

  it("rejects malformed multipart input before queueing", async () => {
    const agent = new Agent({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
    });

    await expect(
      agent.send([{ type: "image", mediaType: "image/png" }] as never)
    ).rejects.toThrow(
      'Agent input content parts must be { type: "text", text }, { type: "image", image }, or { type: "file", data, mediaType }.'
    );
  });

  it("rejects malformed explicit user-message input before queueing", async () => {
    const agent = new Agent({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
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

  it("session.send accepts user-message events", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([]);
      },
    });

    await collect(
      await agent.session("custom").send(
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
            { type: "file", data: "iVBORw0KGgo=", mediaType: "image" },
          ],
        },
      ],
    ]);
  });

  it("session.send accepts user-text events", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([]);
      },
    });

    await collect(
      await agent.session("custom").send({ type: "user-text", text: "hello" })
    );

    expect(seenHistory).toEqual([[userTextToModelMessage(userText("hello"))]]);
  });
});
