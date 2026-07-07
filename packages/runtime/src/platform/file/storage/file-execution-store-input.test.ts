import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileExecutionStore } from "./file-execution-store";
import {
  base64Url,
  currentDataDirectory,
  tempDir,
} from "./file-execution-store-test-support";

const invalidThreadInputFieldsPattern =
  /Invalid FileExecutionStore file .*thread input fields/;

describe("FileExecutionStore thread inputs", () => {
  it("persists thread input records across store instances", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);

    await expect(
      store.inputs.admit({
        admittedAtMs: 10,
        input: { text: "persisted input", type: "user-input" },
        kind: "send",
        messageId: "input:persist",
        threadKey: "thread:persist",
      })
    ).resolves.toMatchObject({
      duplicate: false,
      record: {
        messageId: "input:persist",
        status: "pending",
      },
    });

    const reopened = new FileExecutionStore(directory);
    await expect(
      reopened.inputs.claimNext("thread:persist", "turn-idle")
    ).resolves.toMatchObject({
      messageId: "input:persist",
      status: "claiming",
    });
    const dataDirectory = await currentDataDirectory(directory);
    await expect(readdir(join(dataDirectory, "inputs"))).resolves.toContain(
      `${base64Url("thread:persist")}.json`
    );
    await expect(
      readFile(
        join(dataDirectory, "inputs", `${base64Url("thread:persist")}.json`),
        "utf8"
      )
    ).resolves.toContain('"status": "claiming"');
  });

  it("rolls back file-backed thread input writes after a failure", async () => {
    const store = new FileExecutionStore(await tempDir());

    await expect(
      store.transaction(async (tx) => {
        await tx.inputs.admit({
          admittedAtMs: 10,
          input: { text: "rollback", type: "user-input" },
          kind: "send",
          messageId: "input:rollback",
          threadKey: "thread:rollback",
        });
        throw new Error("rollback me");
      })
    ).rejects.toThrow("rollback me");

    await expect(
      store.inputs.claimNext("thread:rollback", "turn-idle")
    ).resolves.toBeNull();
  });

  it("preserves and updates file-backed thread inputs in committed transactions", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.inputs.admit({
      admittedAtMs: 10,
      input: { text: "transactional input", type: "user-input" },
      kind: "send",
      messageId: "input:transaction",
      threadKey: "thread:transaction",
    });
    const claimed = await store.inputs.claimNext(
      "thread:transaction",
      "turn-idle"
    );
    if (!claimed) {
      throw new Error("Expected file-backed thread input claim.");
    }

    await store.transaction(async (tx) => {
      const promoted = await tx.inputs.markPromoted(claimed);
      expect(promoted).toMatchObject({
        messageId: "input:transaction",
        status: "promoted",
      });
      if (!promoted) {
        throw new Error("Expected promoted thread input.");
      }

      await expect(tx.inputs.ack(promoted)).resolves.toMatchObject({
        messageId: "input:transaction",
        status: "acked",
      });
    });

    await expect(
      store.inputs.claimNext("thread:transaction", "turn-idle")
    ).resolves.toBeNull();
    const dataDirectory = await currentDataDirectory(directory);
    await expect(
      readFile(
        join(
          dataDirectory,
          "inputs",
          `${base64Url("thread:transaction")}.json`
        ),
        "utf8"
      )
    ).resolves.toContain('"status": "acked"');
  });

  it("rejects malformed persisted thread input records", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.inputs.admit({
      admittedAtMs: 10,
      input: { text: "malformed", type: "user-input" },
      kind: "send",
      messageId: "input:malformed",
      threadKey: "thread:malformed",
    });
    const dataDirectory = await currentDataDirectory(directory);
    await writeFile(
      join(dataDirectory, "inputs", `${base64Url("thread:malformed")}.json`),
      `${JSON.stringify([{ threadKey: "thread:malformed" }])}\n`,
      "utf8"
    );

    await expect(
      new FileExecutionStore(directory).inputs.claimNext(
        "thread:malformed",
        "turn-idle"
      )
    ).rejects.toThrow(invalidThreadInputFieldsPattern);
  });

  it("rejects malformed persisted user input content arrays", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.inputs.admit({
      admittedAtMs: 10,
      input: { text: "malformed content", type: "user-input" },
      kind: "send",
      messageId: "input:malformed-content",
      threadKey: "thread:malformed-content",
    });
    const dataDirectory = await currentDataDirectory(directory);
    await writeFile(
      join(
        dataDirectory,
        "inputs",
        `${base64Url("thread:malformed-content")}.json`
      ),
      `${JSON.stringify([
        {
          admittedAtMs: 10,
          admittedSeq: 1,
          input: { content: [42], type: "user-input" },
          kind: "send",
          messageId: "input:malformed-content",
          status: "pending",
          threadKey: "thread:malformed-content",
        },
      ])}\n`,
      "utf8"
    );

    await expect(
      new FileExecutionStore(directory).inputs.claimNext(
        "thread:malformed-content",
        "turn-idle"
      )
    ).rejects.toThrow(invalidThreadInputFieldsPattern);
  });

  it("rejects malformed persisted content when text is also present", async () => {
    const directory = await tempDir();
    const store = new FileExecutionStore(directory);
    await store.inputs.admit({
      admittedAtMs: 10,
      input: { text: "valid text", type: "user-input" },
      kind: "send",
      messageId: "input:mixed-malformed-content",
      threadKey: "thread:mixed-malformed-content",
    });
    const dataDirectory = await currentDataDirectory(directory);
    await writeFile(
      join(
        dataDirectory,
        "inputs",
        `${base64Url("thread:mixed-malformed-content")}.json`
      ),
      `${JSON.stringify([
        {
          admittedAtMs: 10,
          admittedSeq: 1,
          input: {
            content: [42],
            text: "ok",
            type: "user-input",
          },
          kind: "send",
          messageId: "input:mixed-malformed-content",
          status: "pending",
          threadKey: "thread:mixed-malformed-content",
        },
      ])}\n`,
      "utf8"
    );

    await expect(
      new FileExecutionStore(directory).inputs.claimNext(
        "thread:mixed-malformed-content",
        "turn-idle"
      )
    ).rejects.toThrow(invalidThreadInputFieldsPattern);
  });
});
