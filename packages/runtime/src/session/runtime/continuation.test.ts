import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  createCallbackModel,
  sentUserText,
  steerRuntimeInput,
  steerRuntimeInputMessage,
  userText,
} from "../../testing/test-fixtures";
import type { AgentEvent } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";

describe("Agent session runtime input continuation", () => {
  it("active session.steer at step-end continues the current turn with appended user input", async () => {
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(calls === 1 ? "This could be final." : "DONE"),
        ]);
      }),
    });
    const session = agent.thread("step-end-steer");
    const run = await session.send("initial user");
    const events: AgentEvent[] = [];
    let injected = false;

    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "step-end" && !injected) {
        injected = true;
        await session.steer("extra");
      }
    }

    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText("initial user"))],
      [
        userTextToModelMessage(userText("initial user")),
        assistantMessage("This could be final."),
        userTextToModelMessage(userText("extra")),
      ],
    ]);
    expect(events).toEqual([
      sentUserText("initial user"),
      { type: "turn-start" },
      { type: "step-start" },
      { type: "assistant-text", text: "This could be final." },
      { type: "step-end" },
      steerRuntimeInput("extra", "step-end"),
      { type: "step-start" },
      { type: "assistant-text", text: "DONE" },
      { type: "step-end" },
      { type: "turn-end" },
    ]);
  });

  it("normalizes multipart image and file session.steer input like session.send", async () => {
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
    const session = agent.thread("multipart-steer");
    const run = await session.send("initial");
    const runtimeInputs: AgentEvent[] = [];
    let added = false;

    for await (const event of run.events()) {
      if (event.type === "step-start" && !added) {
        added = true;
        await session.steer(input);
      }
      if (event.type === "runtime-input") {
        runtimeInputs.push(event);
      }
    }

    expect(runtimeInputs).toEqual([
      steerRuntimeInputMessage(input, "step-start"),
    ]);
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("initial")),
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
  });
});
