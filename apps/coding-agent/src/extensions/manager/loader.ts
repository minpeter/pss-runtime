import { realpath } from "node:fs/promises";
import type { CodingAgentExtensionInput } from "../types";
import { loadExtensionTarget } from "./module-loader";
import { extensionScopePaths, extensionTrustPath } from "./paths";
import { readExtensionSettings, readTrustedProjects } from "./settings";
import type {
  ImportExtensionModule,
  LoadedConfiguredExtensions,
} from "./types";

export async function loadConfiguredCodingAgentExtensions({
  cwd,
  home,
  importer,
}: {
  readonly cwd: string;
  readonly home: string;
  readonly importer?: ImportExtensionModule;
}): Promise<LoadedConfiguredExtensions> {
  const [globalPaths, projectPaths] = await Promise.all([
    extensionScopePaths({ cwd, home, scope: "global" }),
    extensionScopePaths({ cwd, home, scope: "project" }),
  ]);
  const [globalSettings, projectSettings, trustedProjects, project] =
    await Promise.all([
      readExtensionSettings(globalPaths.settingsPath),
      readExtensionSettings(projectPaths.settingsPath),
      readTrustedProjects(extensionTrustPath(home)),
      realpath(cwd),
    ]);
  const projectTrusted = trustedProjects.includes(project);
  const extensions: CodingAgentExtensionInput[] = [];
  for (const entry of globalSettings.extensions) {
    if (entry.enabled) {
      extensions.push(
        await loadExtensionTarget({
          id: entry.id,
          ...(importer === undefined ? {} : { importer }),
          installRoot: globalPaths.installRoot,
          target: entry.target,
        })
      );
    }
  }
  if (projectTrusted) {
    for (const entry of projectSettings.extensions) {
      if (entry.enabled) {
        extensions.push(
          await loadExtensionTarget({
            id: entry.id,
            ...(importer === undefined ? {} : { importer }),
            installRoot: projectPaths.installRoot,
            target: entry.target,
          })
        );
      }
    }
  }
  const hasBlockedProjectExtension =
    !projectTrusted &&
    projectSettings.extensions.some((entry) => entry.enabled);
  return {
    extensions,
    notices: hasBlockedProjectExtension
      ? [
          "Project extensions are blocked until explicitly enabled or installed for this project.",
        ]
      : [],
  };
}
