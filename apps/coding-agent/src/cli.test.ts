import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodingAgentCli } from "./cli";

describe("coding-agent CLI", () => {
  it("routes inspect-thread through the local inspection surface", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-coding-agent-cli-"));
    let output = "";

    try {
      const exitCode = await runCodingAgentCli({
        argv: ["inspect-thread"],
        cwd: "/repo/demo",
        env: {
          PSS_THREAD_DIR: directory,
          PSS_THREAD_KEY: "workspace:demo",
        },
        home: "/home/me",
        stdout: {
          write(text: string): void {
            output += text;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(output).toContain("threadKey: workspace:demo\n");
      expect(output).toContain("messageCount: 0\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
