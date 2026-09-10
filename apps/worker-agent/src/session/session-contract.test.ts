import { describe, expect, expectTypeOf, it } from "vitest";

import type { ChannelAddress } from "../channel";
import {
  parseSessionChannel,
  parseThreadEventCursor,
  type SerializedThreadEventCursor,
  serializeSessionChannel,
  serializeThreadEventCursor,
  type ThreadEventCursor,
} from "./session-contract";

describe("session event cursor contract", () => {
  it.each([0, 42])(
    "serializes offset %i as its canonical decimal form and round-trips it",
    (offset) => {
      const cursor = { offset } satisfies ThreadEventCursor;
      const serialized = serializeThreadEventCursor(cursor);

      expect(serialized).toBe(String(offset));
      expect(parseThreadEventCursor(serialized)).toEqual(cursor);
      expectTypeOf(serialized).toEqualTypeOf<SerializedThreadEventCursor>();
    }
  );

  it.each(["", "-1", "1.5", "01", "offset:1", "not-a-cursor"])(
    "rejects malformed serialized cursor %j",
    (serialized) => {
      expect(() => parseThreadEventCursor(serialized)).toThrow(
        "invalid thread event cursor"
      );
    }
  );
});

describe("session channel serialization contract", () => {
  it.each([
    [{ id: "local", kind: "tui" }, "tui:local"],
    [{ id: "424242", kind: "telegram" }, "telegram:424242"],
  ] satisfies [ChannelAddress, string][])(
    "serializes %j as <kind>:<id> (%s) and parses it back exactly",
    (channel, serialized) => {
      expect(serializeSessionChannel(channel)).toBe(serialized);
      expect(parseSessionChannel(serialized)).toEqual(channel);
      expect(serializeSessionChannel(parseSessionChannel(serialized))).toBe(
        serialized
      );
    }
  );

  it.each(["local", ":local", "tui:", "tui:   ", "sms:424242", "web:local"])(
    "rejects malformed serialized channel %j",
    (serialized) => {
      expect(() => parseSessionChannel(serialized)).toThrow(
        "invalid session channel"
      );
    }
  );
});
