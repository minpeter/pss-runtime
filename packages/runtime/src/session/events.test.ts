import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("session event protocol boundary", () => {
  it("does not depend on the session implementation module", async () => {
    const source = await readFile(new URL("./events.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/from "\.\/session"/);
  });
});
