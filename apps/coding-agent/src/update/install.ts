import { spawn } from "node:child_process";
import type { UpdateChannel } from "./check";
import { CODING_AGENT_PACKAGE_NAME } from "./check";
import type { InstallMethod, PackageManager } from "./install-method";

export interface InstallInvocation {
  readonly args: readonly string[];
  readonly command: string;
}

export function installInvocation({
  manager,
  version,
  platform,
}: {
  manager: PackageManager;
  version: string;
  platform: NodeJS.Platform;
}): InstallInvocation {
  const spec = `${CODING_AGENT_PACKAGE_NAME}@${version}`;
  const baseArgs = managerInstallArgs(manager, spec);
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", manager, ...baseArgs],
    };
  }
  return { command: manager, args: baseArgs };
}

function managerInstallArgs(
  manager: PackageManager,
  spec: string
): readonly string[] {
  switch (manager) {
    case "pnpm":
      return ["add", "-g", spec];
    case "npm":
      return ["install", "-g", spec];
    case "bun":
      return ["install", "-g", spec];
    case "yarn":
      return ["global", "add", spec];
    default:
      return assertNever(manager);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected package manager: ${JSON.stringify(value)}`);
}

export function formatInvocation(invocation: InstallInvocation): string {
  return [invocation.command, ...invocation.args].join(" ");
}

export function describeInstallMethod(method: InstallMethod): string {
  switch (method.kind) {
    case "global":
      return `${method.manager} (global install)`;
    case "ephemeral":
      return `${method.runner} (one-off cache)`;
    case "unknown":
      return "unknown";
    default:
      return assertNever(method);
  }
}

export function manualInstallCommands(channel: UpdateChannel): string {
  return [
    `  pnpm add -g ${CODING_AGENT_PACKAGE_NAME}@${channel}`,
    `  npm install -g ${CODING_AGENT_PACKAGE_NAME}@${channel}`,
    `  bun install -g ${CODING_AGENT_PACKAGE_NAME}@${channel}`,
    "",
  ].join("\n");
}

export const defaultSpawnInstall = (
  command: string,
  args: readonly string[]
): Promise<number> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
