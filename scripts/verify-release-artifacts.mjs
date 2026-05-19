#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_PACKAGES = ["runtime", "coding-agent"];
const RAW_RUNTIME_DECLARATION_TOKENS = [
  "LanguageModel",
  "ToolSet",
  "ModelMessage",
  "AssistantModelMessage",
  "ToolModelMessage",
  "generateText",
];

const RELATIVE_IMPORT_RE =
  /(?:from\s+["']|import\s*["'])(\.\.?\/[^"']+)(?:["'])/g;
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

function findRuntimeDeclarationLeaks({ cwd }) {
  const runtimeDist = packageDistPath(cwd, "runtime");
  const declarationFiles = listFiles(runtimeDist, (file) =>
    file.endsWith(".d.ts")
  );
  const errors = [];

  for (const file of declarationFiles) {
    const text = readFileSync(file, "utf8");
    const publicRootDeclaration = file === join(runtimeDist, "index.d.ts");

    for (const token of RAW_RUNTIME_DECLARATION_TOKENS) {
      if (!text.includes(token)) {
        continue;
      }

      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (!line.includes(token)) {
          return;
        }

        if (!(publicRootDeclaration || line.startsWith("export "))) {
          return;
        }

        errors.push(
          `${relativeToCwd(cwd, file)}:${index + 1}: unauthorized runtime declaration token ${token}`
        );
      });
    }
  }

  return errors;
}

function relativeToCwd(cwd, file) {
  return file.startsWith(cwd) ? file.slice(cwd.length + 1) : file;
}

function verifyReleaseArtifacts(options) {
  return [
    ...requirePackageDists(options),
    ...findExtensionlessRelativeImports(options),
    ...findPublishedTestArtifacts(options),
    ...findRuntimeDeclarationLeaks(options),
  ];
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  findExtensionlessRelativeImports,
  findPublishedTestArtifacts,
  findRuntimeDeclarationLeaks,
  requirePackageDists,
  verifyReleaseArtifacts,
};
