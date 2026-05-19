import fs, { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const distDir = process.argv[2];
if (!distDir) {
  throw new Error("Usage: node fix-esm-imports.mjs <distDir>");
}

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

const files = walk(distDir);
const relImportRe = /(?:from\s+|import\()(["'])(\.\.?\/.+?)(\1)/g;
const importSpecifierRe = /^(\.\.?\/.+)$/;
for (const file of files) {
  let content = fs.readFileSync(file, "utf8");
  let changed = false;
  content = content.replace(relImportRe, (match, _quote, spec, _full) => {
    if (
      !importSpecifierRe.test(spec) ||
      spec.endsWith(".js") ||
      spec.endsWith(".json")
    ) {
      return match;
    }
    const absoluteNoExt = resolve(dirname(file), spec);
    if (existsSync(`${absoluteNoExt}.js`)) {
      changed = true;
      return match.replace(spec, `${spec}.js`);
    }
    if (existsSync(join(absoluteNoExt, "index.js"))) {
      changed = true;
      return match.replace(
        spec,
        `${spec.endsWith("/") ? spec : `${spec}/`}index.js`
      );
    }
    return match;
  });

  if (changed) {
    fs.writeFileSync(file, content, "utf8");
  }
}
