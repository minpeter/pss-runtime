import { describe, expect, it } from "vitest";
import {
  applyListLimit,
  isDefined,
  isScheduledThreadPrompt,
  normalizedListLimit,
  scheduledWorkIdPart,
  threadPromptScheduledWorkId,
} from "./scheduled-work";

describe("scheduled work ids", () => {
  it("length-prefixes id parts so separators cannot collide", () => {
    expect(scheduledWorkIdPart("run-1")).toBe("5:run-1");
    expect(scheduledWorkIdPart("")).toBe("0:");
    expect(
      threadPromptScheduledWorkId({
        idempotencyKey: "a|b",
        runId: "run-1",
        threadKey: "thread-1",
      })
    ).toBe("8:thread-1|3:a|b|5:run-1");
  });

  it("derives distinct ids for prompts that differ only by one part", () => {
    const base = { runId: "run-1", threadKey: "thread-1" } as const;
    const withKey = threadPromptScheduledWorkId({
      ...base,
      idempotencyKey: "idem",
    });
    const withoutKey = threadPromptScheduledWorkId(base);
    expect(withKey).not.toBe(withoutKey);
  });
});

describe("scheduled thread prompt validation", () => {
  it("accepts prompts with only a thread key", () => {
    expect(isScheduledThreadPrompt({ threadKey: "thread-1" })).toBe(true);
  });

  it("accepts optional string fields and rejects other shapes", () => {
    expect(
      isScheduledThreadPrompt({
        idempotencyKey: "idem",
        notificationId: "note",
        runId: "run-1",
        threadKey: "thread-1",
      })
    ).toBe(true);
    expect(isScheduledThreadPrompt({ threadKey: 1 })).toBe(false);
    expect(isScheduledThreadPrompt({ threadKey: "t", runId: 2 })).toBe(false);
    expect(isScheduledThreadPrompt(null)).toBe(false);
    expect(isScheduledThreadPrompt(["thread-1"])).toBe(false);
    expect(isScheduledThreadPrompt("thread-1")).toBe(false);
  });
});

describe("list limits", () => {
  it("normalizes limits to non-negative integers", () => {
    expect(normalizedListLimit(undefined)).toBeUndefined();
    expect(normalizedListLimit(2.9)).toBe(2);
    expect(normalizedListLimit(-1)).toBe(0);
  });

  it("applies limits without mutating the input", () => {
    const values = ["a", "b", "c"];
    expect(applyListLimit(values, 2)).toEqual(["a", "b"]);
    expect(applyListLimit(values, undefined)).toEqual(values);
    expect(applyListLimit(values, undefined)).not.toBe(values);
    expect(values).toHaveLength(3);
  });
});

describe("isDefined", () => {
  it("narrows away undefined", () => {
    expect([1, undefined, 2].filter(isDefined)).toEqual([1, 2]);
  });
});
