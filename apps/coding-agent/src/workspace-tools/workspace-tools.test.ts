import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionOptions } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceTools } from "./index";

const fileHashPattern = /file_hash: ([0-9a-f]{8})/u;
const firstLineAnchorPattern = /1#[ZPMQVRWSNKTXJBYH]{2}(?=\|)/u;
const grepResultPattern = /src\/new\.ts:1#[ZPMQVRWSNKTXJBYH]{2}\|needle/u;
const secondLineAnchorPattern = /2#[ZPMQVRWSNKTXJBYH]{2}(?=\|)/u;
const staleFileHashPattern = /Stale file hash/u;
const symlinkPattern = /symlink/u;
const workspaceEscapePattern = /escapes workspace/u;

const executionOptions: ToolExecutionOptions<Record<string, unknown>> = {
  context: {},
  messages: [],
  toolCallId: "workspace-tool-test",
};

function executableTool(
  tools: ReturnType<typeof createWorkspaceTools>,
  name: string
) {
  const execute = tools[name]?.execute;
  if (typeof execute !== "function") {
    throw new TypeError(`Expected executable tool: ${name}`);
  }
  return execute;
}

describe("workspace coding tools", () => {
  let outside: string;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "pss-workspace-"));
    outside = await mkdtemp(join(tmpdir(), "pss-outside-"));
    await mkdir(join(workspace, "src"));
    await writeFile(
      join(workspace, "src", "example.ts"),
      "export const first = 1;\nexport const second = 2;\n",
      "utf8"
    );
  });

  afterEach(async () => {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it("reads hashline anchors and applies deterministic edits", async () => {
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const edit = executableTool(tools, "edit_file");
    const initial = String(
      await read({ path: "src/example.ts" }, executionOptions)
    );
    const anchor = initial.match(secondLineAnchorPattern)?.[0];
    const fileHash = initial.match(fileHashPattern)?.[1];
    expect(anchor).toBeDefined();
    expect(fileHash).toBeDefined();
    if (anchor === undefined || fileHash === undefined) {
      throw new Error("Expected hashline metadata.");
    }

    await edit(
      {
        edits: [
          {
            lines: ["export const second = 3;"],
            op: "replace",
            pos: anchor,
          },
        ],
        expected_file_hash: fileHash,
        path: "src/example.ts",
      },
      executionOptions
    );

    await expect(
      readFile(join(workspace, "src", "example.ts"), "utf8")
    ).resolves.toBe("export const first = 1;\nexport const second = 3;\n");
  });

  it("rejects stale anchors and stale file hashes", async () => {
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const edit = executableTool(tools, "edit_file");
    const initial = String(
      await read({ path: "src/example.ts" }, executionOptions)
    );
    const anchor = initial.match(firstLineAnchorPattern)?.[0];
    const fileHash = initial.match(fileHashPattern)?.[1];
    if (anchor === undefined || fileHash === undefined) {
      throw new Error("Expected hashline metadata.");
    }
    await writeFile(join(workspace, "src", "example.ts"), "changed\n", "utf8");

    await expect(
      edit(
        {
          edits: [{ lines: ["replacement"], op: "replace", pos: anchor }],
          expected_file_hash: fileHash,
          path: "src/example.ts",
        },
        executionOptions
      )
    ).rejects.toThrow(staleFileHashPattern);
  });

  it("keeps file operations inside the workspace", async () => {
    const tools = createWorkspaceTools({ workspace });
    const read = executableTool(tools, "read_file");
    const write = executableTool(tools, "write_file");
    await expect(
      read({ path: "../outside.txt" }, executionOptions)
    ).rejects.toThrow(workspaceEscapePattern);

    await symlink(outside, join(workspace, "linked"), "dir");
    await expect(
      write({ content: "escape", path: "linked/escape.txt" }, executionOptions)
    ).rejects.toThrow(symlinkPattern);
  });

  it("supports glob, grep, shell, write, and delete workflows", async () => {
    const tools = createWorkspaceTools({ workspace });
    const glob = executableTool(tools, "glob_files");
    const grep = executableTool(tools, "grep_files");
    const shell = executableTool(tools, "shell_execute");
    const write = executableTool(tools, "write_file");
    const remove = executableTool(tools, "delete_file");

    await write({ content: "needle\n", path: "src/new.ts" }, executionOptions);
    await expect(
      glob({ path: "src", pattern: "*.ts" }, executionOptions)
    ).resolves.toContain("src/new.ts");
    await expect(
      grep(
        { fixed_strings: true, include: "*.ts", pattern: "needle" },
        executionOptions
      )
    ).resolves.toMatch(grepResultPattern);
    await expect(
      shell({ command: "pwd" }, executionOptions)
    ).resolves.toContain(workspace);

    const executable = join(workspace, "script.sh");
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o755);
    await write(
      { content: "#!/bin/sh\necho ok\n", path: "script.sh" },
      executionOptions
    );
    expect((await stat(executable)).mode % 0o1000).toBe(0o755);

    await remove({ path: "src/new.ts" }, executionOptions);
    await expect(
      readFile(join(workspace, "src", "new.ts"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
