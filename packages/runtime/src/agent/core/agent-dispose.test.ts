import { describe, expect, it, vi } from "vitest";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { DisposedResourceError } from "../../thread/state/thread-errors";
import { Agent } from "./agent";

const fakeModel = createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]);

describe("Agent.dispose", () => {
  it.each([undefined, null])(
    "preserves a %s thread disposal rejection",
    async (reason) => {
      const agent = new Agent({ model: fakeModel });
      const first = agent.thread("first-rejecting-disposal");
      const later = agent.thread("later-rejecting-disposal");
      vi.spyOn(first, "dispose").mockRejectedValue(reason);
      const laterDispose = vi
        .spyOn(later, "dispose")
        .mockRejectedValue(new Error("later disposal failure"));

      const outcome = await agent.dispose().then(
        () => ({ resolved: true }) as const,
        (rejection: unknown) => ({ rejection, resolved: false }) as const
      );

      expect(outcome).toEqual({ rejection: reason, resolved: false });
      expect(laterDispose).toHaveBeenCalledOnce();
      expect(agent.thread("first-rejecting-disposal")).toBe(first);
      expect(agent.thread("later-rejecting-disposal")).toBe(later);
    }
  );

  it("rejects commands after a successful disposal and stays idempotent", async () => {
    // Given: an agent that has been disposed successfully.
    const agent = new Agent({ model: fakeModel });
    agent.thread("before-dispose");
    await agent[Symbol.asyncDispose]();

    // When/Then: every command method rejects with DisposedResourceError.
    expect(() => agent.thread("after-dispose")).toThrow(DisposedResourceError);
    expect(() => agent.send("hello")).toThrow(DisposedResourceError);
    expect(() => agent.followUp("hello")).toThrow(DisposedResourceError);
    expect(() => agent.overlay("hello")).toThrow(DisposedResourceError);
    await expect(agent.resume("any-run")).rejects.toBeInstanceOf(
      DisposedResourceError
    );

    // Then: further disposal remains a no-op.
    await expect(agent.dispose()).resolves.toBeUndefined();
    await expect(agent[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});
