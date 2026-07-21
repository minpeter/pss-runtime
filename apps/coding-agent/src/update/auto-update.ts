import { realpathSync } from "node:fs";
import type { UpdateNotice } from "./check";
import {
  defaultSpawnInstall,
  formatInvocation,
  installInvocation,
} from "./install";
import { classifyInstallPath, type PackageManager } from "./install-method";
import { isUpdateCheckDisabled } from "./notifier";
import { isSameMajorVersion } from "./version";

export interface AutoUpdatePlan {
  readonly manager: PackageManager;
  readonly target: string;
}

export function isAutoUpdateEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.PSS_AUTO_UPDATE?.trim().toLowerCase();
  return (value === "1" || value === "true") && !isUpdateCheckDisabled(env);
}

export interface PlanAutoUpdateOptions {
  readonly binPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly notice: UpdateNotice | undefined;
  readonly realpath?: (path: string) => string;
  readonly version: string;
}

export function planAutoUpdate({
  notice,
  version,
  env,
  binPath,
  realpath = defaultRealpath,
}: PlanAutoUpdateOptions): AutoUpdatePlan | undefined {
  if (notice === undefined || notice.kind !== "channel-update") {
    return;
  }
  if (!isAutoUpdateEnabled(env)) {
    return;
  }
  if (!isSameMajorVersion(version, notice.latestVersion)) {
    return;
  }

  const method = classifyInstallPath(realpath(binPath));
  if (method.kind !== "global") {
    return;
  }

  return { manager: method.manager, target: notice.latestVersion };
}

const defaultRealpath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export interface RunAutoUpdateOptions {
  readonly platform: NodeJS.Platform;
  readonly spawnInstall?: (
    command: string,
    args: readonly string[]
  ) => Promise<number>;
  readonly stdout: { write(text: string): void };
}

export async function runAutoUpdate(
  plan: AutoUpdatePlan,
  { platform, stdout, spawnInstall = defaultSpawnInstall }: RunAutoUpdateOptions
): Promise<number> {
  const invocation = installInvocation({
    manager: plan.manager,
    version: plan.target,
    platform,
  });
  stdout.write(
    `auto-update: installing pss ${plan.target} via \`${formatInvocation(invocation)}\`...\n`
  );
  const code = await spawnInstall(invocation.command, invocation.args);
  if (code !== 0) {
    stdout.write(
      `auto-update failed (exit ${code}). Update manually:\n  ${formatInvocation(invocation)}\n`
    );
    return code;
  }

  stdout.write(
    `auto-update complete: pss ${plan.target}. Restart pss to use the new version.\n`
  );
  return 0;
}
