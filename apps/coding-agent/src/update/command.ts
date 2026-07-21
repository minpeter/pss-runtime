import {
  CODING_AGENT_PACKAGE_NAME,
  fetchLatestTags,
  resolveUpdateRegistryBaseUrl,
  type UpdateChannel,
} from "./check";
import {
  defaultSpawnInstall,
  describeInstallMethod,
  formatInvocation,
  installInvocation,
  manualInstallCommands,
} from "./install";
import { detectInstallMethod, type InstallMethod } from "./install-method";
import { compareVersions, extractUpdateChannel } from "./version";

export interface UpdateCommandDeps {
  readonly args: readonly string[];
  readonly binPath: string;
  readonly detectInstall?: () => Promise<InstallMethod>;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchTags?: () => Promise<
    Readonly<Partial<Record<UpdateChannel, string>>>
  >;
  readonly platform: NodeJS.Platform;
  readonly spawnInstall?: (
    command: string,
    args: readonly string[]
  ) => Promise<number>;
  readonly stdout: { write(text: string): void };
  readonly version: string | undefined;
}

interface ParsedUpdateArgs {
  readonly channel: UpdateChannel | undefined;
  readonly check: boolean;
}

export async function runUpdateCommand({
  args,
  stdout,
  env,
  version,
  binPath,
  platform,
  fetchTags = () =>
    fetchLatestTags({ baseUrl: resolveUpdateRegistryBaseUrl(env) }),
  detectInstall = () => detectInstallMethod({ binPath }),
  spawnInstall = defaultSpawnInstall,
}: UpdateCommandDeps): Promise<number> {
  const parsed = parseUpdateArgs(args);
  if (parsed === undefined) {
    stdout.write("Usage: pss update [--check] [--channel latest|next]\n");
    return 1;
  }

  const ownChannel =
    version === undefined ? undefined : extractUpdateChannel(version);
  const targetChannel = parsed.channel ?? ownChannel ?? "latest";

  if (ownChannel === "latest" && targetChannel === "next") {
    stdout.write(
      `pss update keeps stable installs on the latest channel. If you really want the next channel, install it manually:\n  pnpm add -g ${CODING_AGENT_PACKAGE_NAME}@next\n`
    );
    return 1;
  }

  if (parsed.check) {
    return runUpdateCheck({
      stdout,
      version,
      ownChannel,
      targetChannel,
      channelExplicit: parsed.channel !== undefined,
      platform,
      fetchTags,
      detectInstall,
    });
  }

  if (version === undefined) {
    stdout.write(
      `pss cannot update itself from a source checkout. Install pss globally first:\n  pnpm add -g ${CODING_AGENT_PACKAGE_NAME}\n`
    );
    return 1;
  }

  const method = await detectInstall();
  if (method.kind === "ephemeral") {
    stdout.write(
      `this pss is running from a one-off ${method.runner} cache; there is nothing to update. Install pss globally instead:\n  pnpm add -g ${CODING_AGENT_PACKAGE_NAME}@${targetChannel}\n`
    );
    return 1;
  }
  if (method.kind === "unknown") {
    stdout.write(
      `could not detect how pss was installed. Update manually with one of:\n${manualInstallCommands(targetChannel)}`
    );
    return 1;
  }

  const tags = await fetchTags();
  const target = tags[targetChannel];
  if (target === undefined) {
    stdout.write(
      `could not check for updates right now. Try again later or update manually:\n${manualInstallCommands(targetChannel)}`
    );
    return 1;
  }

  if (
    target === version ||
    (parsed.channel === undefined && compareVersions(target, version) < 0)
  ) {
    stdout.write(`pss is up to date (${version}).\n`);
    return 0;
  }

  const invocation = installInvocation({
    manager: method.manager,
    version: target,
    platform,
  });
  stdout.write(
    `Updating pss ${version} -> ${target} via \`${formatInvocation(invocation)}\`...\n`
  );
  const code = await spawnInstall(invocation.command, invocation.args);
  if (code !== 0) {
    stdout.write(
      `update failed (exit ${code}). Try manually:\n  ${formatInvocation(invocation)}\n`
    );
    return code;
  }

  stdout.write(
    `Updated pss to ${target}. Restart pss to use the new version.\n`
  );
  return 0;
}

interface RunUpdateCheckOptions {
  readonly channelExplicit: boolean;
  readonly detectInstall: () => Promise<InstallMethod>;
  readonly fetchTags: () => Promise<
    Readonly<Partial<Record<UpdateChannel, string>>>
  >;
  readonly ownChannel: UpdateChannel | undefined;
  readonly platform: NodeJS.Platform;
  readonly stdout: { write(text: string): void };
  readonly targetChannel: UpdateChannel;
  readonly version: string | undefined;
}

async function runUpdateCheck({
  stdout,
  version,
  ownChannel,
  targetChannel,
  channelExplicit,
  platform,
  fetchTags,
  detectInstall,
}: RunUpdateCheckOptions): Promise<number> {
  const [tags, method] = await Promise.all([fetchTags(), detectInstall()]);

  stdout.write(
    `current version: ${version ?? "unknown (dev build)"}${ownChannel === undefined ? "" : ` (channel: ${ownChannel})`}\n`
  );
  stdout.write(`install method: ${describeInstallMethod(method)}\n`);
  stdout.write(
    `registry tags: latest=${tags.latest ?? "unknown"}, next=${tags.next ?? "unknown"}\n`
  );

  if (version === undefined) {
    stdout.write("update status cannot be determined for a dev build.\n");
    return 0;
  }

  const target = tags[targetChannel];
  if (target === undefined) {
    stdout.write("could not check for updates right now.\n");
    return 0;
  }
  if (
    target === version ||
    (!channelExplicit && compareVersions(target, version) < 0)
  ) {
    stdout.write(`pss is up to date (${version}).\n`);
    return 0;
  }

  stdout.write(`update available: ${version} -> ${target}\n`);
  if (method.kind === "global") {
    const invocation = installInvocation({
      manager: method.manager,
      version: target,
      platform,
    });
    stdout.write(`would run: ${formatInvocation(invocation)}\n`);
  } else {
    stdout.write(
      `install pss globally to update:\n${manualInstallCommands(targetChannel)}`
    );
  }
  return 0;
}

function parseUpdateArgs(
  args: readonly string[]
): ParsedUpdateArgs | undefined {
  let check = false;
  let channel: UpdateChannel | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--channel") {
      const value = args[index + 1];
      if (value === "latest" || value === "next") {
        channel = value;
        index += 1;
        continue;
      }
      return;
    }
    return;
  }

  return { check, channel };
}
