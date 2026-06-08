import type { getSandbox } from "@cloudflare/sandbox";
import type {
  SandboxFileEditRequest,
  SandboxUserRoute,
} from "../request/agent-api";

export interface SandboxSdkEnv {
  readonly Sandbox?: Parameters<typeof getSandbox>[0];
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stderr?: string;
  readonly stdout: string;
  readonly success: boolean;
}

export interface SandboxFileEditDemoResult {
  readonly exec?: SandboxExecResult;
  readonly file: {
    readonly content: string;
    readonly path: string;
    readonly readContent?: string;
  };
  readonly operations: readonly SandboxOperation[];
  readonly sandboxConfigured: boolean;
  readonly sandboxName: string;
  readonly tenantId: string;
  readonly userId: string;
}

export interface SandboxOperation {
  readonly command?: string;
  readonly method: "exec" | "getSandbox" | "mkdir" | "readFile" | "writeFile";
  readonly target: string;
}

export interface SandboxRuntime {
  exec(command: string): Promise<SandboxExecResult>;
  mkdir(
    path: string,
    options?: { readonly recursive?: boolean }
  ): Promise<unknown>;
  readFile(
    path: string,
    options?: { readonly encoding?: "utf-8" }
  ): Promise<{ readonly content: string; readonly path: string }>;
  writeFile(path: string, content: string): Promise<unknown>;
}

export interface RunSandboxFileEditDemoOptions {
  readonly env: SandboxSdkEnv;
  readonly fileEdit: SandboxFileEditRequest;
  readonly route: SandboxUserRoute;
  readonly sandboxFactory?: (
    env: SandboxSdkEnv,
    sandboxName: string
  ) => Promise<SandboxRuntime | undefined> | SandboxRuntime | undefined;
}

export async function runSandboxFileEditDemo(
  options: RunSandboxFileEditDemoOptions
): Promise<SandboxFileEditDemoResult> {
  const operations = plannedOperations(
    options.route.sandboxName,
    options.fileEdit.path
  );
  const sandbox = await createSandboxRuntime(options);
  if (!sandbox) {
    return baseResult(options, operations, false);
  }

  await sandbox.mkdir("/workspace", { recursive: true });
  await sandbox.writeFile(options.fileEdit.path, options.fileEdit.content);
  const exec = await sandbox.exec(`python ${options.fileEdit.path}`);
  const readBack = await sandbox.readFile(options.fileEdit.path, {
    encoding: "utf-8",
  });
  return {
    ...baseResult(options, operations, true),
    exec,
    file: {
      content: options.fileEdit.content,
      path: options.fileEdit.path,
      readContent: readBack.content,
    },
  };
}

function baseResult(
  options: RunSandboxFileEditDemoOptions,
  operations: readonly SandboxOperation[],
  sandboxConfigured: boolean
): SandboxFileEditDemoResult {
  return {
    file: {
      content: options.fileEdit.content,
      path: options.fileEdit.path,
    },
    operations,
    sandboxConfigured,
    sandboxName: options.route.sandboxName,
    tenantId: options.route.tenantId,
    userId: options.route.userId,
  };
}

async function createSandboxRuntime(
  options: RunSandboxFileEditDemoOptions
): Promise<SandboxRuntime | undefined> {
  if (options.sandboxFactory) {
    return await options.sandboxFactory(options.env, options.route.sandboxName);
  }
  if (!options.env.Sandbox) {
    return;
  }
  const sandboxModule = await import("@cloudflare/sandbox");
  return sandboxModule.getSandbox(
    options.env.Sandbox,
    options.route.sandboxName
  );
}

function plannedOperations(
  sandboxName: string,
  path: string
): readonly SandboxOperation[] {
  return [
    { method: "getSandbox", target: sandboxName },
    { method: "mkdir", target: "/workspace" },
    { method: "writeFile", target: path },
    { command: `python ${path}`, method: "exec", target: path },
    { method: "readFile", target: path },
  ];
}
