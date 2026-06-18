import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("runtime docs", () => {
  it("keeps raw run.events as the public control loop", () => {
    const readme = readRepoFile("packages/runtime/README.md");
    const changeset = readRepoFile(".changeset/runtime-plugin-sessions.md");
    const runSource = readRepoFile(
      "packages/runtime/src/session/protocol/run.ts"
    );

    expect(readme).toContain("for await (const event of run.events())");
    expect(readme).toContain("session.steer");
    expect(readme).not.toContain("consumeRunEvents");
    expect(changeset).toContain('"@minpeter/pss-runtime": patch');
    expect(changeset).not.toContain("consumeRunEvents");
    expect(runSource).not.toContain("consumeRunEvents");
    expect(runSource).not.toContain("AgentRunEventListener");
  });

  it("keeps the durable background host snippet assignable", () => {
    const readme = readRepoFile("packages/runtime/README.md");

    expect(readme).toContain("const durableHost: DurableBackgroundHost = {");
    expect(readme).toContain("transaction,");
  });
});
