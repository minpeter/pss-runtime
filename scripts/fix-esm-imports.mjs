import fs, { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RELATIVE_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|import\s+)(["'])(\.\.?\/[^"']+?)\1/g;
const IMPORT_SPECIFIER_RE = /^(\.\.?\/.+)$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(file, out);
    } else if (entry.isFile() && file.endsWith(".js")) {
      out.push(file);
    }
  }
  return out;
}

function rewriteSpecifier(file, spec) {
  if (
    !IMPORT_SPECIFIER_RE.test(spec) ||
    spec.endsWith(".js") ||
    spec.endsWith(".json")
  ) {
    return spec;
  }

  const absoluteNoExt = resolve(dirname(file), spec);
  if (!spec.endsWith("/") && existsSync(`${absoluteNoExt}.js`)) {
    return `${spec}.js`;
  }
  if (existsSync(join(absoluteNoExt, "index.js"))) {
    return `${spec.endsWith("/") ? spec : `${spec}/`}index.js`;
  }

  return spec;
}

function fixEsmImports(distDir) {
  const files = walk(distDir);

  for (const file of files) {
    fixEsmImportFile(file);
  }
}

function fixEsmImportFile(file) {
  let content = fs.readFileSync(file, "utf8");
  let changed = false;

  content = content.replace(RELATIVE_IMPORT_RE, (match, _quote, spec) => {
    const nextSpec = rewriteSpecifier(file, spec);
    if (nextSpec !== spec) {
      changed = true;
      return match.replace(spec, nextSpec);
    }

    return match;
  });

  if (changed) {
    fs.writeFileSync(file, content, "utf8");
  }
}

function isMainModule(moduleUrl, argvPath = process.argv[1]) {
  return (
    argvPath !== undefined &&
    moduleUrl === pathToFileURL(resolve(argvPath)).href
  );
}

function main() {
  const distDir = process.argv[2];
  if (!distDir) {
    throw new Error("Usage: node fix-esm-imports.mjs <distDir>");
  }

  fixEsmImports(distDir);
}

if (isMainModule(import.meta.url)) {
  main();
}

export { fixEsmImports, isMainModule, rewriteSpecifier };
