import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { compareVersions, isValidVersion } from "./update-version";

export type UpdateChannel = "latest" | "next";

export interface UpdateCheckCache {
  readonly checkedAt: string;
  readonly tags: Readonly<Partial<Record<UpdateChannel, string>>>;
}

export type UpdateNotice =
  | {
      readonly kind: "channel-update";
      readonly channel: UpdateChannel;
      readonly currentVersion: string;
      readonly latestVersion: string;
    }
  | {
      readonly kind: "stable-surpassed";
      readonly currentVersion: string;
      readonly latestVersion: string;
    };

export const UPDATE_CHECK_TTL_MS = 86_400_000;
export const UPDATE_CHECK_CACHE_FILENAME = "update-check.json";
export const CODING_AGENT_PACKAGE_NAME = "@minpeter/pss-coding-agent";
export const DEFAULT_REGISTRY_BASE_URL = "https://registry.npmjs.org";

export interface RegistryFetchResponse {
  json(): Promise<unknown>;
  readonly ok: boolean;
}

export type RegistryFetch = (
  url: string,
  init: { signal: AbortSignal }
) => Promise<RegistryFetchResponse>;

export interface FetchLatestTagsOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: RegistryFetch;
  readonly timeoutMs?: number;
}

const TRACKED_CHANNELS: readonly UpdateChannel[] = ["latest", "next"];

export function isCacheFresh(
  cache: UpdateCheckCache,
  now: number,
  ttlMs: number = UPDATE_CHECK_TTL_MS
): boolean {
  const checkedAt = Date.parse(cache.checkedAt);
  if (Number.isNaN(checkedAt)) {
    return false;
  }
  const age = now - checkedAt;
  return age >= 0 && age < ttlMs;
}

export function decideUpdateNotice(
  current: { version: string; channel: UpdateChannel },
  tags: Readonly<Partial<Record<UpdateChannel, string>>>
): UpdateNotice | undefined {
  const channelTag = tags[current.channel];
  if (
    channelTag !== undefined &&
    isValidVersion(channelTag) &&
    compareVersions(channelTag, current.version) > 0
  ) {
    return {
      kind: "channel-update",
      channel: current.channel,
      currentVersion: current.version,
      latestVersion: channelTag,
    };
  }

  if (current.channel === "next") {
    const stableTag = tags.latest;
    if (
      stableTag !== undefined &&
      isValidVersion(stableTag) &&
      compareVersions(stableTag, current.version) > 0
    ) {
      return {
        kind: "stable-surpassed",
        currentVersion: current.version,
        latestVersion: stableTag,
      };
    }
  }

  return;
}

export function formatUpdateNotice(notice: UpdateNotice): string {
  switch (notice.kind) {
    case "channel-update":
      return `update available: ${notice.currentVersion} -> ${notice.latestVersion} - run "pss update"`;
    case "stable-surpassed":
      return `stable ${notice.latestVersion} is available (you have ${notice.currentVersion}) - run "pss update --channel latest"`;
    default:
      return assertNever(notice);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected update notice: ${JSON.stringify(value)}`);
}

const updateCheckCacheSchema = z.object({
  checkedAt: z.string().min(1),
  tags: z.object({
    latest: z.string().min(1).optional(),
    next: z.string().min(1).optional(),
  }),
});

export function parseUpdateCheckCache(
  text: string
): UpdateCheckCache | undefined {
  try {
    const parsed = updateCheckCacheSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}

export async function readUpdateCheckCache(
  path: string
): Promise<UpdateCheckCache | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return parseUpdateCheckCache(text);
  } catch {
    return;
  }
}

export async function writeUpdateCheckCache(
  path: string,
  cache: UpdateCheckCache
): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${UPDATE_CHECK_CACHE_FILENAME}.${process.pid}.tmp`
  );
  await writeFile(temporaryPath, `${JSON.stringify(cache)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function fetchLatestTags({
  baseUrl = DEFAULT_REGISTRY_BASE_URL,
  fetchImpl = defaultRegistryFetch,
  timeoutMs = 3000,
}: FetchLatestTagsOptions = {}): Promise<
  Readonly<Partial<Record<UpdateChannel, string>>>
> {
  const entries = await Promise.all(
    TRACKED_CHANNELS.map(async (channel) => {
      const version = await fetchTagVersion({
        baseUrl,
        channel,
        fetchImpl,
        timeoutMs,
      });
      return version === undefined ? undefined : ([channel, version] as const);
    })
  );

  const tags: Partial<Record<UpdateChannel, string>> = {};
  for (const entry of entries) {
    if (entry !== undefined) {
      tags[entry[0]] = entry[1];
    }
  }
  return tags;
}

const defaultRegistryFetch: RegistryFetch = (url, init) => fetch(url, init);

interface FetchTagVersionOptions {
  readonly baseUrl: string;
  readonly channel: UpdateChannel;
  readonly fetchImpl: RegistryFetch;
  readonly timeoutMs: number;
}

async function fetchTagVersion({
  baseUrl,
  channel,
  fetchImpl,
  timeoutMs,
}: FetchTagVersionOptions): Promise<string | undefined> {
  const url = `${baseUrl}/${encodeURIComponent(CODING_AGENT_PACKAGE_NAME)}/${encodeURIComponent(channel)}`;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return;
    }

    const payload: unknown = await response.json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      "version" in payload &&
      typeof payload.version === "string" &&
      isValidVersion(payload.version)
    ) {
      return payload.version;
    }
    return;
  } catch {
    return;
  }
}

export function resolveUpdateRegistryBaseUrl(env: NodeJS.ProcessEnv): string {
  const override = env.PSS_UPDATE_REGISTRY_BASE_URL?.trim();
  return override === undefined || override === ""
    ? DEFAULT_REGISTRY_BASE_URL
    : override;
}
