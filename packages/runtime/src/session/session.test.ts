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
import { AgentSession } from "./session";
import { collect } from "./session.test-support";
import { MemorySessionStore } from "./store/memory";

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

  it("calls event plugins for queued turn events", async () => {
    const pluginCalls: string[] = [];
    const agent = new Agent({
      plugins: [
        {
          events: {
            on: ({ event, history }) => {
              pluginCalls.push(`${event.type}:${history.length}`);
            },
          },
        },
      ],
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
    expect(pluginCalls).toEqual([
      "user-text:0",
      "turn-start:1",
      "step-start:1",
      "assistant-text:2",
      "step-end:2",
      "turn-end:2",
    ]);
  });

  it("lets plugins branch on emitted run events", async () => {
    const pluginEventTypes: string[] = [];
    const agent = new Agent({
      plugins: [
        {
          events: {
            on: async ({ event }) => {
              if (event.type === "subagent-job-start") {
                await Promise.resolve();
              }
              pluginEventTypes.push(event.type);
            },
          },
        },
      ],
      llm: () => Promise.resolve([assistantMessage("DONE")]),
    });

    const events = await collect(await agent.send("hello"));

    expect(pluginEventTypes).toEqual(eventTypes(events));
  });

  it("routes observer events through event plugins", async () => {
    const pluginEventTypes: string[] = [];
    const session = new AgentSession(
      () => Promise.resolve([assistantMessage("DONE")]),
      { key: "observer-events", store: new MemorySessionStore() },
      [
        {
          events: {
            on: ({ event }) => {
              pluginEventTypes.push(event.type);
            },
          },
        },
      ]
    );

    const run = await session.send("hello");
    const iterator = run.events()[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({
      type: "user-text",
      text: "hello",
    });
    expect((await iterator.next()).value).toEqual({ type: "turn-start" });

    await session.emitObserverEvent({
      run_in_background: false,
      subagent: "researcher",
      type: "subagent-job-start",
    });

    const events = [
      (await iterator.next()).value,
      (await iterator.next()).value,
    ];
    await iterator.return?.();

    expect(eventTypes(events)).toContain("subagent-job-start");
    expect(pluginEventTypes).toContain("subagent-job-start");
  });

  it("commits successful output before terminal event plugin failures", async () => {
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      plugins: [
        {
          events: {
            on: ({ event }) => {
              if (event.type === "turn-end") {
                throw new Error("turn-end plugin failed");
              }
            },
          },
        },
      ],
      llm: ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage(`DONE ${calls}`)]);
      },
    });

    const firstEvents = await collect(
      await agent.session("terminal-event").send("first")
    );
    const secondEvents = await collect(
      await agent.session("terminal-event").send("second")
    );

    expect(eventTypes(firstEvents)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-error",
    ]);
    expect(eventTypes(secondEvents)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-error",
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

  it("rejects sparse text arrays before queueing", async () => {
    const sparseInput = new Array<string>(1);
    const agent = new Agent({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
    });

    await expect(agent.send(sparseInput)).rejects.toThrow(
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

  it("rejects explicit user-message content that is not an array", async () => {
    const agent = new Agent({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
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
