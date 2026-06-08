import type { getSandbox, SandboxOptions } from "@cloudflare/sandbox";
import type {
  SandboxFileEditRequest,
  SandboxUserRoute,
} from "../request/agent-api";

export interface SandboxSdkEnv {
  readonly AGENT_SANDBOX_INSTANCE_TIMEOUT_MS?: string;
  readonly AGENT_SANDBOX_POLL_INTERVAL_MS?: string;
  readonly AGENT_SANDBOX_PORT_TIMEOUT_MS?: string;
  readonly AGENT_SANDBOX_TRANSPORT?: string;
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

const sandboxUnavailableSignals = [
  "Container is starting",
  "Container failed to start",
  "Failed after",
  "Network connection lost",
];

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

export function sandboxRuntimeUnavailableReason(
  error: unknown
): string | undefined {
  const detail = errorDetails(error);
  if (!sandboxUnavailableSignals.some((signal) => detail.includes(signal))) {
    return;
  }
  return errorMessage(error) || "Cloudflare Sandbox container is unavailable.";
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
    options.route.sandboxName,
    sandboxOptionsFromEnv(options.env)
  );
}

function sandboxOptionsFromEnv(env: SandboxSdkEnv): SandboxOptions | undefined {
  const instanceGetTimeoutMS = readPositiveInteger(
    env.AGENT_SANDBOX_INSTANCE_TIMEOUT_MS
  );
  const portReadyTimeoutMS = readPositiveInteger(
    env.AGENT_SANDBOX_PORT_TIMEOUT_MS
  );
  const waitIntervalMS = readPositiveInteger(
    env.AGENT_SANDBOX_POLL_INTERVAL_MS
  );
  const transport = readSandboxTransport(env.AGENT_SANDBOX_TRANSPORT);
  const containerTimeouts =
    instanceGetTimeoutMS || portReadyTimeoutMS || waitIntervalMS
      ? { instanceGetTimeoutMS, portReadyTimeoutMS, waitIntervalMS }
      : undefined;
  if (!(containerTimeouts || transport)) {
    return;
  }
  return { containerTimeouts, transport };
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return [error.name, error.message, error.stack ?? ""].join("\n");
  }
  return typeof error === "string" ? error : "";
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : undefined;
}

function readPositiveInteger(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readSandboxTransport(
  value: string | undefined
): SandboxOptions["transport"] | undefined {
  switch (value?.trim()) {
    case "http":
    case "websocket":
    case "rpc":
      return value.trim() as SandboxOptions["transport"];
    default:
      return;
  }
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
