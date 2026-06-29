import { describe, expect, it } from "vitest";

import { createTuiResponseMessageSink } from "./tui-response-sink";

describe("TUI response message sink", () => {
  it("captures send_message output for a request-scoped TUI response", async () => {
    const responseSink = createTuiResponseMessageSink();

    await expect(
      responseSink.sink.send({ id: "local", kind: "tui" }, "hello")
    ).resolves.toEqual({
      channel: "tui:local",
      messageId: "tui-1",
    });

    expect(responseSink.messages()).toEqual([
      {
        channel: "tui:local",
        messageId: "tui-1",
        text: "hello",
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
