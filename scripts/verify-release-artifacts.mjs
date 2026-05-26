#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_PACKAGES = ["runtime", "coding-agent"];
const REQUIRED_PACKAGE_BINS = {
  "coding-agent": {
    pss: "./bin/pss.js",
    "pss-coding-agent": "./bin/pss.js",
  },
};
const RAW_RUNTIME_DECLARATION_TOKENS = [
  "LanguageModel",
  "ToolSet",
  "ModelMessage",
  "AssistantModelMessage",
  "ToolModelMessage",
  "generateText",
];
const RUNTIME_DECLARATION_ALLOWLIST = new Set([
  "agent.d.ts",
  "agent-loop.d.ts",
  "llm.d.ts",
  "session/history.d.ts",
  "session/mapping.d.ts",
]);
const REQUIRED_RUNTIME_ROOT_ALIASES = [
  "AgentModel",
  "AgentRun",
  "AgentTools",
  "RuntimeCreateLlmOptions",
  "RuntimeInput",
  "RuntimeLlm",
  "RuntimeLlmContext",
  "RuntimeLlmOutput",
];
const FORBIDDEN_RUNTIME_ROOT_ALIASES = [
  "AgentMessage",
  "AgentRunInput",
  "RunInput",
];

const RELATIVE_IMPORT_RE =
  /(?:from\s+["']|import\s*(?:\(\s*)?["'])(\.\.?\/[^"']+)(?:["'])/g;
const TEST_ARTIFACT_RE =
  /(?:^|[/\\])(?:__tests__|test-fixtures?)(?:[/\\]|\.)|\.(?:test|spec)\.(?:d\.)?[cm]?js$/i;
const JAVASCRIPT_ARTIFACT_RE = /\.[cm]?js$/;

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    packages: [...DEFAULT_PACKAGES],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--cwd") {
      options.cwd = resolve(argv.at(index + 1) ?? "");
      index += 1;
      continue;
    }

    if (arg === "--package") {
      const packageName = argv.at(index + 1);
      if (!packageName) {
        throw new Error("--package requires a package directory name");
      }
      if (options.packages.length === DEFAULT_PACKAGES.length) {
        options.packages = [];
      }
      options.packages.push(packageName);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function listFiles(root, predicate = () => true) {
  if (!existsSync(root)) {
    return [];
  }

  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

function packageDistPath(cwd, packageName) {
  return join(cwd, "packages", packageName, "dist");
}

function requirePackageDists({ cwd, packages }) {
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

function findExtensionlessRelativeImports({ cwd, packages }) {
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

function findPublishedTestArtifacts({ cwd, packages }) {
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

function findPackageBinEntrypointErrors({
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

    const { bin } = packageJson.value;
    const checkedTargets = new Set();
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
  }

  return errors;
}

function readJsonForVerification({ cwd, file }) {
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return {
      error: `${relativeToCwd(cwd, file)}: cannot read package.json (${errorMessage(error)})`,
    };
  }
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

function readTextForVerification(file) {
  try {
    return { value: readFileSync(file, "utf8") };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function readModeForVerification(file) {
  try {
    return { value: statSync(file).mode };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function hasExecutablePermission(mode) {
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX file mode checks are the canonical use of execute-bit masks.
  return (mode & 0o111) !== 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findRuntimeDeclarationLeaks({ cwd, packages }) {
  if (!packages.includes("runtime")) {
    return [];
  }

  const runtimeDist = packageDistPath(cwd, "runtime");
  const declarationFiles = listFiles(runtimeDist, (file) =>
    file.endsWith(".d.ts")
  );
  const rootDeclarationPath = join(runtimeDist, "index.d.ts");

  return declarationFiles.flatMap((file) =>
    file === rootDeclarationPath
      ? findRuntimeRootDeclarationLeaks({ cwd, file })
      : findRuntimeInternalDeclarationLeaks({ cwd, file, runtimeDist })
  );
}

function findRuntimeRootDeclarationLeaks({ cwd, file }) {
  const text = readFileSync(file, "utf8");
  const errors = RAW_RUNTIME_DECLARATION_TOKENS.filter((token) =>
    text.includes(token)
  ).map(
    (token) =>
      `${relativeToCwd(cwd, file)}: root declaration exposes raw AI SDK token ${token}`
  );

  for (const alias of FORBIDDEN_RUNTIME_ROOT_ALIASES) {
    if (text.includes(alias)) {
      errors.push(
        `${relativeToCwd(cwd, file)}: root declaration exposes internal runtime alias ${alias}`
      );
    }
  }

  for (const alias of REQUIRED_RUNTIME_ROOT_ALIASES) {
    if (!text.includes(alias)) {
      errors.push(
        `${relativeToCwd(cwd, file)}: missing explicit runtime alias ${alias}`
      );
    }
  }

  return errors;
}

function findRuntimeInternalDeclarationLeaks({ cwd, file, runtimeDist }) {
  const relative = relativeToCwd(runtimeDist, file);
  if (RUNTIME_DECLARATION_ALLOWLIST.has(relative)) {
    return [];
  }

  const text = readFileSync(file, "utf8");
  return RAW_RUNTIME_DECLARATION_TOKENS.filter((token) =>
    text.includes(token)
  ).map(
    (token) =>
      `${relativeToCwd(cwd, file)}: unauthorized runtime declaration token ${token}`
  );
}

function relativeToCwd(cwd, file) {
  return file.startsWith(cwd) ? file.slice(cwd.length + 1) : file;
}

function verifyReleaseArtifacts(options) {
  return [
    ...requirePackageDists(options),
    ...findPackageBinEntrypointErrors(options),
    ...findExtensionlessRelativeImports(options),
    ...findPublishedTestArtifacts(options),
    ...findRuntimeDeclarationLeaks(options),
  ];
}

function isMainModule(moduleUrl, argvPath = process.argv[1]) {
  return (
    argvPath !== undefined &&
    moduleUrl === pathToFileURL(resolve(argvPath)).href
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const errors = verifyReleaseArtifacts(options);

  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log("Release artifact verification passed");
}

if (isMainModule(import.meta.url)) {
  main();
}

export {
  findExtensionlessRelativeImports,
  findPackageBinEntrypointErrors,
  findPublishedTestArtifacts,
  findRuntimeDeclarationLeaks,
  isMainModule,
  requirePackageDists,
  verifyReleaseArtifacts,
};
