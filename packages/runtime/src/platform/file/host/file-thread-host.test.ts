import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../../../agent/core/agent";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../../testing/mock-language-model-v4-test-utils";
import { collect } from "../../../thread/handle/test-support";
import { createNodeFileThreadHost } from "./file-thread-host";

const corruptJsonPattern = /invalid JSON/;

function tempDir() {
  return mkdtemp(join(tmpdir(), "pss-runtime-node-host-"));
}

function threadFileName(key: string): string {
  return `${Buffer.from(key).toString("base64url")}.json`;
}

describe("createNodeFileThreadHost", () => {
  it("persists isolated thread history across reconstructed agent instances", async () => {
    const directory = await tempDir();
    try {
      const first = new Agent({
        host: createNodeFileThreadHost({ directory }),
        model: createMockLanguageModelV4([
          mockLanguageModelV4Text("stored-a"),
          mockLanguageModelV4Text("stored-b"),
        ]),
      });

      await collect(await first.thread("thread:a").send("first a"));
      await collect(await first.thread("thread:b").send("first b"));

      const secondModel = createMockLanguageModelV4([
        mockLanguageModelV4Text("done"),
      ]);
      const second = new Agent({
        host: createNodeFileThreadHost({ directory }),
        model: secondModel,
      });

      await collect(await second.thread("thread:a").send("second a"));

      const prompt = JSON.stringify(secondModel.doGenerateCalls[0]?.prompt);
      expect(prompt).toContain("first a");
      expect(prompt).toContain("second a");
      expect(prompt).not.toContain("first b");
      await expect(readdir(directory)).resolves.toEqual(
        expect.arrayContaining([
          threadFileName("thread:a"),
          threadFileName("thread:b"),
        ])
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("surfaces malformed stored files through the backing FileThreadStore", async () => {
    const directory = await tempDir();
    try {
      await writeFile(
        join(directory, threadFileName("bad-thread")),
        "{ nope",
        "utf8"
      );
      const agent = new Agent({
        host: createNodeFileThreadHost({ directory }),
        model: createMockLanguageModelV4([mockLanguageModelV4Text("unused")]),
      });

      await expect(agent.thread("bad-thread").send("hello")).rejects.toThrow(
        corruptJsonPattern
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
