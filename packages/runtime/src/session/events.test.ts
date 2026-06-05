import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sessionImplementationImportPattern = /from "\.\/session"/;
const recursiveEventPayloadPattern = /\|\s*\{[^}]*\bevent\??:\s*AgentEvent\b/s;
const eventsSourceUrl = new URL("./events.ts", import.meta.url);

const readEventsSource = () => readFile(eventsSourceUrl, "utf8");

describe("session event protocol boundary", () => {
  it("does not depend on the session implementation module", async () => {
    const source = await readEventsSource();

    expect(source).not.toMatch(sessionImplementationImportPattern);
  });

  it("uses non-recursive subagent lifecycle event payloads", async () => {
    const source = await readEventsSource();

    expect(source).toContain('type: "subagent-job-start"');
    expect(source).toContain('type: "subagent-job-update"');
    expect(source).toContain('type: "subagent-job-end"');
    expect(source).toContain('eventType?: AgentEvent["type"]');
    expect(source).not.toMatch(recursiveEventPayloadPattern);
  });
});
