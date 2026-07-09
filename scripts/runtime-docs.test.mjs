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
    const changelog = readRepoFile("packages/runtime/CHANGELOG.md");
    const turnSource = readRepoFile(
      "packages/runtime/src/thread/protocol/turn.ts"
    );

    expect(readme).toContain("for await (const event of turn.events())");
    expect(readme).toContain("thread.steer");
    expect(readme).not.toContain("consumeRunEvents");
    expect(changelog).toContain("## 0.1.0");
    expect(changelog).not.toContain("consumeRunEvents");
    expect(turnSource).not.toContain("consumeRunEvents");
    expect(turnSource).not.toContain("AgentRunEventListener");
  });

  it("documents the single AgentHost factory surface", () => {
    const readme = readRepoFile("packages/runtime/README.md");

    expect(readme).toContain("createInMemoryHost");
    expect(readme).toContain("createFileHost");
    expect(readme).toContain("const host: AgentHost = createInMemoryHost()");
    expect(readme).not.toContain("DurableBackgroundHost");
    expect(readme).not.toContain("createNodeFileThreadHost");
    expect(readme).not.toContain("createInMemoryExecutionHost");
  });
});
