import { describe, expect, it } from "vitest";
import { runSandboxFileEditDemo, type SandboxRuntime } from "./file-edit";

const fileEdit = {
  content: "print('hello')",
  filename: "hello.py",
  path: "/workspace/hello.py",
};
const route = {
  sandboxName: "tenant-tenant-a-user-user-a",
  tenantId: "tenant-a",
  userId: "user-a",
};

describe("sandbox file edit demo", () => {
  it("returns a deterministic operation plan when the Sandbox binding is absent", async () => {
    const result = await runSandboxFileEditDemo({
      env: {},
      fileEdit,
      route,
    });

    expect(result).toMatchObject({
      file: { path: "/workspace/hello.py" },
      operations: [
        { method: "getSandbox", target: "tenant-tenant-a-user-user-a" },
        { method: "mkdir", target: "/workspace" },
        { method: "writeFile", target: "/workspace/hello.py" },
        {
          command: "python /workspace/hello.py",
          method: "exec",
          target: "/workspace/hello.py",
        },
        { method: "readFile", target: "/workspace/hello.py" },
      ],
      sandboxConfigured: false,
      sandboxName: "tenant-tenant-a-user-user-a",
    });
  });

  it("creates a per-user Sandbox, edits a file, executes it, and reads it back", async () => {
    const calls: string[] = [];
    const sandbox: SandboxRuntime = {
      exec: (command) => {
        calls.push(`exec ${command}`);
        return Promise.resolve({
          exitCode: 0,
          stdout: "hello\n",
          success: true,
        });
      },
      mkdir: (path) => {
        calls.push(`mkdir ${path}`);
        return Promise.resolve({});
      },
      readFile: (path) => {
        calls.push(`readFile ${path}`);
        return Promise.resolve({ content: "print('hello')", path });
      },
      writeFile: (path, content) => {
        calls.push(`writeFile ${path} ${content}`);
        return Promise.resolve({});
      },
    };

    const result = await runSandboxFileEditDemo({
      env: {},
      fileEdit,
      route,
      sandboxFactory: (_env, sandboxName) => {
        calls.push(`getSandbox ${sandboxName}`);
        return sandbox;
      },
    });

    expect(calls).toEqual([
      "getSandbox tenant-tenant-a-user-user-a",
      "mkdir /workspace",
      "writeFile /workspace/hello.py print('hello')",
      "exec python /workspace/hello.py",
      "readFile /workspace/hello.py",
    ]);
    expect(result).toMatchObject({
      exec: { exitCode: 0, stdout: "hello\n", success: true },
      file: {
        content: "print('hello')",
        path: "/workspace/hello.py",
        readContent: "print('hello')",
      },
      sandboxConfigured: true,
    });
  });
});
