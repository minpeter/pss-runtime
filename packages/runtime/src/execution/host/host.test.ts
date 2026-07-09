import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import { threadStoreFromHost } from "./host";

describe("threadStoreFromHost", () => {
  it("returns the host store threads port", () => {
    const host = createInMemoryHost();
    expect(threadStoreFromHost(host)).toBe(host.store.threads);
  });
});
