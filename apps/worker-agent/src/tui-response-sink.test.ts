import { describe, expect, it } from "vitest";

import { createTuiResponseMessageSink } from "./tui-response-sink";

describe("TUI response message sink", () => {
  it("captures send_message output for a request-scoped TUI response", async () => {
    const responseSink = createTuiResponseMessageSink();

    await expect(
      responseSink.sink.send({ id: "local", kind: "tui" }, "hello")
    ).resolves.toEqual({
      messageId: "tui-1",
      threadId: "tui:local",
    });

    expect(responseSink.messages()).toEqual([
      {
        messageId: "tui-1",
        text: "hello",
        threadId: "tui:local",
      },
    ]);
  });

  it("rejects non-TUI channels", async () => {
    const responseSink = createTuiResponseMessageSink();

    await expect(
      responseSink.sink.send({ id: "chat-1", kind: "telegram" }, "hello")
    ).rejects.toThrow("TUI response sink can only send to tui channels.");
  });
});
