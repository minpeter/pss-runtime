import { describe, expect, it } from "vitest";
import { matchDocumentedPath } from "./worker-api-contract.mjs";
import { paths } from "./worker-api-contract-test-helpers.mjs";

describe("worker api contract: path matching", () => {
  it("matches concrete paths, aliases, the procedure template, and the catch-all", () => {
    const entries = paths();
    expect(matchDocumentedPath(entries, "/healthz")?.docPath).toBe("/healthz");
    expect(matchDocumentedPath(entries, "/healthz/")?.docPath).toBe("/healthz");
    expect(
      matchDocumentedPath(entries, "/trpc/session.replayEvents")?.docPath
    ).toBe("/trpc/session.replayEvents");
    expect(matchDocumentedPath(entries, "/trpc/does-not-exist")?.docPath).toBe(
      "/trpc/{procedure}"
    );
    expect(matchDocumentedPath(entries, "/trpc")?.docPath).toBe("/trpc");
    expect(matchDocumentedPath(entries, "/")?.docPath).toBe("/{webhookPath}");
    expect(matchDocumentedPath(entries, "/healthz/foo")?.docPath).toBe(
      "/{webhookPath}"
    );
    expect(
      matchDocumentedPath(entries, "/session/events/replay")?.docPath
    ).toBe("/{webhookPath}");
  });
});
