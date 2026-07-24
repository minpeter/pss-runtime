import { realpath } from "node:fs/promises";
import { extensionScopePaths, extensionTrustPath } from "./paths";
import {
  readExtensionSettings,
  readTrustedProjects,
  writeExtensionSettings,
  writeTrustedProjects,
} from "./settings";
import type {
  ExtensionManagerContext,
  ExtensionScope,
  ExtensionSettingsEntry,
  ListedExtension,
} from "./types";

export async function listExtensions(
  context: ExtensionManagerContext & {
    readonly scope?: ExtensionScope;
  }
): Promise<readonly ListedExtension[]> {
  const scopes: readonly ExtensionScope[] =
    context.scope === undefined ? ["global", "project"] : [context.scope];
  const projectTrusted = await isProjectTrusted(context);
  const listed: ListedExtension[] = [];
  for (const scope of scopes) {
    const document = await readExtensionSettings(
      (await extensionScopePaths({ ...context, scope })).settingsPath
    );
    for (const entry of document.extensions) {
      listed.push({
        ...entry,
        scope,
        status: extensionStatus(entry.enabled, scope, projectTrusted),
      });
    }
  }
  return listed;
}

function extensionStatus(
  enabled: boolean,
  scope: ExtensionScope,
  projectTrusted: boolean
): ListedExtension["status"] {
  if (!enabled) {
    return "disabled";
  }
  return scope === "project" && !projectTrusted ? "blocked" : "enabled";
}

export async function setExtensionEnabled(
  context: ExtensionManagerContext & {
    readonly all: boolean;
    readonly enabled: boolean;
    readonly ids: readonly string[];
    readonly scope: ExtensionScope;
  }
): Promise<readonly ExtensionSettingsEntry[]> {
  if (!context.all && context.ids.length === 0) {
    throw new TypeError("Provide extension ids or --all");
  }
  const paths = await extensionScopePaths(context);
  const document = await readExtensionSettings(paths.settingsPath);
  const selected = context.all
    ? new Set(document.extensions.map((entry) => entry.id))
    : new Set(context.ids);
  assertIdsExist(document.extensions, selected);
  const changed = document.extensions.map((entry) =>
    selected.has(entry.id) ? { ...entry, enabled: context.enabled } : entry
  );
  await writeExtensionSettings(paths.settingsPath, {
    ...document,
    extensions: changed,
  });
  if (context.enabled && context.scope === "project") {
    await trustProject(context);
  }
  return changed.filter((entry) => selected.has(entry.id));
}

export async function trustProject(
  context: ExtensionManagerContext
): Promise<void> {
  const project = await realpath(context.cwd);
  const path = extensionTrustPath(context.home);
  const projects = await readTrustedProjects(path);
  if (!projects.includes(project)) {
    await writeTrustedProjects(path, [...projects, project]);
  }
}

async function isProjectTrusted(
  context: ExtensionManagerContext
): Promise<boolean> {
  const project = await realpath(context.cwd);
  const projects = await readTrustedProjects(extensionTrustPath(context.home));
  return projects.includes(project);
}

function assertIdsExist(
  entries: readonly ExtensionSettingsEntry[],
  selected: ReadonlySet<string>
): void {
  const installed = new Set(entries.map((entry) => entry.id));
  for (const id of selected) {
    if (!installed.has(id)) {
      throw new Error(`Extension "${id}" is not installed`);
    }
  }
}
