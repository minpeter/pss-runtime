import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  isRecord,
  packageDistPath,
  packageRootPath,
  readJsonForVerification,
  relativeToCwd,
} from "./shared.mjs";

const EXTENSION_CONTRACTS = {
  "extension-latex": {
    artifacts: ["index.js", "index.d.ts", "mathjax-worker.js"],
    name: "@minpeter/pss-extension-latex",
  },
  "extension-mermaid": {
    artifacts: ["index.js", "index.d.ts", "mermaid-art-worker.js"],
    name: "@minpeter/pss-extension-mermaid",
  },
  "extension-web": {
    artifacts: ["index.js", "index.d.ts"],
    name: "@minpeter/pss-extension-web",
  },
};

function extensionManifestIsValid(value, contract) {
  if (!isRecord(value)) {
    return false;
  }
  const rootExport = isRecord(value.exports) ? value.exports["."] : undefined;
  const publishConfig = isRecord(value.publishConfig)
    ? value.publishConfig
    : undefined;
  return (
    value.name === contract.name &&
    value.license === "SEE LICENSE IN LICENSE.md" &&
    isRecord(rootExport) &&
    rootExport.import === "./dist/index.js" &&
    rootExport.types === "./dist/index.d.ts" &&
    Array.isArray(value.files) &&
    value.files.includes("dist") &&
    value.files.includes("LICENSE.md") &&
    publishConfig?.access === "public" &&
    publishConfig.provenance === true
  );
}

export function findExtensionArtifactErrors({ cwd, packages }) {
  const errors = [];

  for (const packageName of packages) {
    const contract = EXTENSION_CONTRACTS[packageName];
    if (!contract) {
      continue;
    }

    const packageRoot = packageRootPath(cwd, packageName);
    const packageJsonPath = join(packageRoot, "package.json");
    const packageJson = readJsonForVerification({ cwd, file: packageJsonPath });
    if (packageJson.error) {
      errors.push(packageJson.error);
    } else if (!extensionManifestIsValid(packageJson.value, contract)) {
      errors.push(
        `${relativeToCwd(cwd, packageJsonPath)}: invalid extension package contract`
      );
    }

    const licensePath = join(packageRoot, "LICENSE.md");
    if (!(existsSync(licensePath) && statSync(licensePath).isFile())) {
      errors.push(
        `${relativeToCwd(cwd, licensePath)} is missing; required extension license artifact`
      );
    }

    const distPath = packageDistPath(cwd, packageName);
    if (!(existsSync(distPath) && statSync(distPath).isDirectory())) {
      continue;
    }
    for (const artifact of contract.artifacts) {
      const artifactPath = join(distPath, artifact);
      if (!existsSync(artifactPath)) {
        errors.push(
          `${relativeToCwd(cwd, artifactPath)} is missing; required extension artifact`
        );
      }
    }
  }

  return errors;
}
