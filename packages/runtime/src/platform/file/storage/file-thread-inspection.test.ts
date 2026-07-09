import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeThreadSnapshot } from "../../../thread/state/snapshot";
import { createFileHost } from "../host/file-host";
import {
  fileThreadStorageHint,
  inspectFileThread,
} from "./file-thread-inspection";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pss-runtime-file-inspect-"));
}

describe("inspectFileThread", () => {
  it("reports stored history and compaction metadata from the file host", async () => {
    const directory = await tempDir();
    const threadKey = "inspect:thread";
    const summary = {
      content: "older context summary",
      role: "system",
    } as const;
    const summaryBytes = Buffer.byteLength(JSON.stringify(summary), "utf8");

    try {
      const host = createFileHost({ directory });
      await host.store.threads.commit(
        threadKey,
        {
          state: encodeThreadSnapshot(
            [
              { content: "first", role: "user" },
              { content: "second", role: "assistant" },
              { content: "third", role: "user" },
            ],
            [
              {
                endSeqExclusive: 2,
                schemaVersion: 1,
                startSeq: 0,
                summary,
              },
            ]
          ),
        },
        { expectedVersion: null }
      );

      await expect(
        inspectFileThread({ directory, key: threadKey })
      ).resolves.toEqual({
        compactionCount: 1,
        compactions: [
          {
            endSeqExclusive: 2,
            startSeq: 0,
            summaryBytes,
          },
        ],
        messageCount: 3,
        storageFile: await fileThreadStorageHint({ directory, key: threadKey }),
        summaryBytes,
        threadKey,
        version: "1",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports a missing thread as empty while preserving its storage path", async () => {
    const directory = await tempDir();
    const threadKey = "missing:thread";

    try {
      await expect(
        inspectFileThread({ directory, key: threadKey })
      ).resolves.toEqual({
        compactionCount: 0,
        compactions: [],
        messageCount: 0,
        storageFile: await fileThreadStorageHint({ directory, key: threadKey }),
        summaryBytes: 0,
        threadKey,
        version: null,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
