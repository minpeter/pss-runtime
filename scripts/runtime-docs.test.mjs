import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("runtime docs", () => {
  it("keeps raw turn.events as the public control loop", () => {
    const readme = readRepoFile("packages/runtime/README.md");
    const changeset = readRepoFile(".changeset/runtime-plugin-sessions.md");
    const turnSource = readRepoFile(
      "packages/runtime/src/thread/protocol/turn.ts"
    );

    expect(readme).toContain("for await (const event of turn.events())");
    expect(readme).toContain("thread.steer");
    expect(readme).not.toContain("consumeRunEvents");
    expect(changeset).toContain('"@minpeter/pss-runtime": patch');
    expect(changeset).not.toContain("consumeRunEvents");
    expect(turnSource).not.toContain("consumeRunEvents");
    expect(turnSource).not.toContain("AgentRunEventListener");
  });

  it("keeps the durable background host snippet assignable", () => {
    const readme = readRepoFile("packages/runtime/README.md");

    expect(readme).toContain("const durableHost: DurableBackgroundHost = {");
    expect(readme).toContain("transaction,");
  });

  it("documents channel adapters as app-owned event projection", () => {
    const readme = readRepoFile("packages/runtime/README.md");
    const changeset = readRepoFile(
      ".changeset/runtime-channel-adapter-contract.md"
    );

    expect(readme).toContain("projectChannelAssistantDelivery(event)");
    expect(readme).toContain(
      "agent.thread(inbound.threadKey).send(inbound.input)"
    );
    expect(readme).toContain("for await (const event of turn.events())");
    expect(readme).toContain("type ChannelInboundMessage");
    expect(changeset).toContain('"@minpeter/pss-runtime": patch');
    expect(readme).not.toContain(["Channel", "Runtime"].join(""));
    expect(readme).not.toContain(["Channel", "Loop"].join(""));
    expect(readme).not.toContain(["run", "Channel"].join(""));
  });
});
