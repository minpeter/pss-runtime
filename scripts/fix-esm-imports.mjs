#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [root = "dist"] = process.argv.slice(2);
const rootPath = resolve(root);

const jsFiles = [];
collectJsFiles(rootPath, jsFiles);

for (const file of jsFiles) {
  const source = readFileSync(file, "utf8");
  const fixed = source.replace(
    /(from\s+["']|import\s*\(\s*["']|import\s+["'])(\.\.?\/[^"']+)(["'])/g,
    (match, prefix, specifier, suffix) => {
      const fixedSpecifier = resolveRelativeSpecifier(file, specifier);
      return fixedSpecifier === specifier
        ? match
        : `${prefix}${fixedSpecifier}${suffix}`;
    }
  );

  if (fixed !== source) {
    writeFileSync(file, fixed);
  }
}

function collectJsFiles(directory, files) {
  if (!existsSync(directory)) {
    return;
  }

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);

    if (stat.isDirectory()) {
      collectJsFiles(path, files);
      continue;
    }

    if (stat.isFile() && path.endsWith(".js")) {
      files.push(path);
    }
  }
}

function resolveRelativeSpecifier(file, specifier) {
  if (
    specifier.endsWith(".js") ||
    specifier.endsWith(".json") ||
    specifier.endsWith(".node")
  ) {
    return specifier;
  }

  const target = resolve(dirname(file), specifier);

  if (existsSync(`${target}.js`)) {
    return `${specifier}.js`;
  }

  if (existsSync(join(target, "index.js"))) {
    return `${specifier}/index.js`;
  }

  return specifier;
}
