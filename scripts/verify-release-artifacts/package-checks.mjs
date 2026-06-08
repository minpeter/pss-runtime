import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  hasExecutablePermission,
  isRecord,
  listFiles,
  packageDistPath,
  readJsonForVerification,
  readModeForVerification,
  readTextForVerification,
  relativeToCwd,
} from "./shared.mjs";

const REQUIRED_PACKAGE_BINS = {
  "coding-agent": {
    pss: "./bin/pss.js",
    "pss-coding-agent": "./bin/pss.js",
  },
};
const RELATIVE_IMPORT_RE =
  /(?:from\s+["']|import\s*(?:\(\s*)?["'])(\.\.?\/[^"']+)(?:["'])/g;
const TEST_ARTIFACT_RE =
  /(?:^|[/\\])(?:__tests__|test-fixtures?)(?:[/\\]|\.)|\.(?:test|spec)\.(?:d\.)?[cm]?js$/i;
const JAVASCRIPT_ARTIFACT_RE = /\.[cm]?js$/;

export function requirePackageDists({ cwd, packages }) {
  const errors = [];

  for (const packageName of packages) {
    const distPath = packageDistPath(cwd, packageName);
    if (!(existsSync(distPath) && statSync(distPath).isDirectory())) {
      errors.push(
        `packages/${packageName}/dist is missing; run the package build first`
      );
    }
  }

  return errors;
}

export function findExtensionlessRelativeImports({ cwd, packages }) {
  const errors = [];

  for (const packageName of packages) {
    const distPath = packageDistPath(cwd, packageName);
    const jsFiles = listFiles(distPath, (file) =>
      JAVASCRIPT_ARTIFACT_RE.test(file)
    );

    for (const file of jsFiles) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(RELATIVE_IMPORT_RE)) {
        const specifier = match[1];
        if (specifier.endsWith(".js") || specifier.endsWith(".json")) {
          continue;
        }

        const target = resolve(dirname(file), specifier);
        if (
          existsSync(`${target}.js`) ||
          existsSync(join(target, "index.js"))
        ) {
          errors.push(
            `${relativeToCwd(cwd, file)}: extensionless relative import ${specifier}`
          );
        }
      }
    }
  }

  return errors;
}

export function findPublishedTestArtifacts({ cwd, packages }) {
  const errors = [];

  for (const packageName of packages) {
    const distPath = packageDistPath(cwd, packageName);
    const files = listFiles(distPath);

    for (const file of files) {
      const relative = relativeToCwd(cwd, file);
      if (TEST_ARTIFACT_RE.test(relative)) {
        errors.push(
          `${relative}: test or fixture artifact must not be published`
        );
      }
    }
  }

  return errors;
}

export function findPackageBinEntrypointErrors({
  cwd,
  packages,
  platform = process.platform,
}) {
  const errors = [];

  for (const packageName of packages) {
    const requiredBins = REQUIRED_PACKAGE_BINS[packageName];
    if (!requiredBins) {
      continue;
    }

    const packageRoot = join(cwd, "packages", packageName);
    const packageJsonPath = join(packageRoot, "package.json");
    const packageJson = readJsonForVerification({ cwd, file: packageJsonPath });

    if (packageJson.error) {
      errors.push(packageJson.error);
      continue;
    }

    if (!(isRecord(packageJson.value) && isRecord(packageJson.value.bin))) {
      errors.push(
        `${relativeToCwd(cwd, packageJsonPath)}: missing bin object for CLI entrypoints`
      );
      continue;
    }

    errors.push(
      ...findPackageBinTargetErrors({
        bin: packageJson.value.bin,
        cwd,
        packageJsonPath,
        packageRoot,
        platform,
        requiredBins,
      })
    );
  }

  return errors;
}

function findPackageBinTargetErrors({
  bin,
  cwd,
  packageJsonPath,
  packageRoot,
  platform,
  requiredBins,
}) {
  const checkedTargets = new Set();
  const errors = [];

  for (const [command, expectedTarget] of Object.entries(requiredBins)) {
    if (bin[command] !== expectedTarget) {
      errors.push(
        `${relativeToCwd(cwd, packageJsonPath)}: bin.${command} must target ${expectedTarget}`
      );
      continue;
    }

    const targetPath = resolve(packageRoot, expectedTarget);
    if (checkedTargets.has(targetPath)) {
      continue;
    }

    checkedTargets.add(targetPath);
    errors.push(
      ...findBinTargetFileErrors({
        command,
        cwd,
        packageJsonPath,
        platform,
        targetPath,
      })
    );
  }

  return errors;
}

function findBinTargetFileErrors({
  command,
  cwd,
  packageJsonPath,
  platform,
  targetPath,
}) {
  if (!existsSync(targetPath)) {
    return [
      `${relativeToCwd(cwd, packageJsonPath)}: bin.${command} target ${relativeToCwd(dirname(packageJsonPath), targetPath)} is missing`,
    ];
  }

  const relativeTarget = relativeToCwd(cwd, targetPath);
  const text = readTextForVerification(targetPath);
  const mode = readModeForVerification(targetPath);
  const errors = [];

  if (text.error) {
    errors.push(
      `${relativeTarget}: cannot read CLI bin target (${text.error})`
    );
  } else if (!text.value.startsWith("#!")) {
    errors.push(`${relativeTarget}: CLI bin target must start with a shebang`);
  }

  if (mode.error) {
    errors.push(
      `${relativeTarget}: cannot stat CLI bin target (${mode.error})`
    );
  } else if (platform !== "win32" && !hasExecutablePermission(mode.value)) {
    errors.push(`${relativeTarget}: CLI bin target must be executable`);
  }

  return errors;
}
