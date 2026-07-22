import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectories = ["scripts", "src", "test"];

async function collectCheckedFiles(directory) {
  const entries = await readdir(join(packageRoot, directory), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectCheckedFiles(relative)));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(relative);
    }
  }
  return files;
}

const checkedFiles = (
  await Promise.all(sourceDirectories.map(collectCheckedFiles))
).flat();

await Promise.all(
  checkedFiles.map((file) =>
    execFileAsync(process.execPath, ["--check", join(packageRoot, file)])
  )
);

const reportPath = resolve(packageRoot, "dist", "build.json");
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(
  reportPath,
  `${JSON.stringify({ checkedFiles, checkedAt: new Date().toISOString() }, null, 2)}\n`,
  "utf8"
);

console.log(`Checked ${checkedFiles.length} Node scripts.`);
