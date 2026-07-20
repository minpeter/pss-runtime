import type { StoredThreadEvent } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";

import {
  createSessionEventLiveSignal,
  createSessionEventStreamResponse,
} from "./session-events";
import { streamRemoteSessionEvents } from "./session-remote";

const firstEvent = {
  cursor: { offset: 0 },
  event: { type: "turn-start" },
  threadKey: "default",
} satisfies StoredThreadEvent;
const secondEvent = {
  cursor: { offset: 1 },
  event: { text: "hello", type: "assistant-output" },
  threadKey: "default",
} satisfies StoredThreadEvent;
const thirdEvent = {
  cursor: { offset: 2 },
  event: { type: "turn-end" },
  threadKey: "default",
} satisfies StoredThreadEvent;

describe("session SSE event stream", () => {
  it("replays committed events before streaming a newly committed event", async () => {
    const committed: StoredThreadEvent[] = [firstEvent, secondEvent];
    const live = createSessionEventLiveSignal();
    const response = createSessionEventStreamResponse({
      live,
      replay: (after) =>
        Promise.resolve(replayAfterCursor(committed, after?.offset)),
    });
    const reader = createSseTestReader(response);

    await expect(reader.next()).resolves.toEqual(firstEvent);
    await expect(reader.next()).resolves.toEqual(secondEvent);

    committed.push(thirdEvent);
    live.publish();

    await expect(reader.next()).resolves.toEqual(thirdEvent);
    await reader.close();
  });

  it("reconnects after a dropped stream with the last received cursor", async () => {
    const requests: Request[] = [];
    const events = [firstEvent, secondEvent];
    const stream = streamRemoteSessionEvents({
      channel: { id: "local", kind: "tui" },
      endpoint: "https://worker.example/session/events",
      fetch: (request) => {
        requests.push(request);
        const event = events.shift();
        if (!event) {
          throw new Error("unexpected third connection");
        }
        return Promise.resolve(
          new Response(formatSseEvent(event), {
            headers: { "content-type": "text/event-stream" },
          })
        );
      },
      token: "secret",
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(withTimeout(iterator.next())).resolves.toEqual({
      done: false,
      value: firstEvent,
    });
    await expect(withTimeout(iterator.next())).resolves.toEqual({
      done: false,
      value: secondEvent,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret");
    expect(
      new URL(requests[0]?.url ?? "").searchParams.get("after")
    ).toBeNull();
    expect(new URL(requests[1]?.url ?? "").searchParams.get("after")).toBe("0");
    await iterator.return?.();
  });
});

function replayAfterCursor(
  committed: readonly StoredThreadEvent[],
  offset: number | undefined
) {
  const events = committed.filter(
    (record) => offset === undefined || record.cursor.offset > offset
  );
  const nextCursor = events.at(-1)?.cursor;
  return {
    events,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function formatSseEvent(event: StoredThreadEvent): string {
  return `id: ${event.cursor.offset}\nevent: thread-event\ndata: ${JSON.stringify(event)}\n\n`;
}

function createSseTestReader(response: Response) {
  if (!response.body) {
    throw new Error("expected SSE response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queued: StoredThreadEvent[] = [];

  return {
    close: () => reader.cancel(),
    async next(): Promise<StoredThreadEvent> {
      while (queued.length === 0) {
        const result = await withTimeout(reader.read());
        if (result.done) {
          throw new Error("SSE stream ended before the next event");
        }
        buffer += decoder.decode(result.value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice("data: ".length);
          if (data) {
            queued.push(JSON.parse(data) as StoredThreadEvent);
          }
        }
      }
      const event = queued.shift();
      if (!event) {
        throw new Error("expected queued SSE event");
      }
      return event;
    },
  };
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for exact stream signal")),
      1000
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
