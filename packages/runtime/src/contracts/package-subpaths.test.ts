import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface RuntimeExport {
  readonly "@minpeter/pss-source": string;
  readonly import?: string;
  readonly types?: string;
}

interface RuntimePackageJson {
  readonly exports: Record<string, RuntimeExport>;
}

describe("runtime package subpaths", () => {
  it("declares memory as a platform implementation subpath", async () => {
    const packageJson = await readRuntimePackageJson();

    expect(packageJson.exports["./platform/memory"]).toMatchObject({
      "@minpeter/pss-source": "./src/platform/memory/index.ts",
      import: "./dist/platform/memory/index.js",
      types: "./dist/platform/memory/index.d.ts",
    });
    expect(packageJson.exports["./thread-store/memory"]).toBeUndefined();
    expect(packageJson.exports["./execution/memory"]).toBeUndefined();
  });

  it("keeps the legacy file thread-store subpath without session aliases", async () => {
    const packageJson = await readRuntimePackageJson();

    expect(packageJson.exports["./thread-store/file"]).toMatchObject({
      "@minpeter/pss-source": "./src/thread/store/file.ts",
    });
    expect(packageJson.exports["./session-store/memory"]).toBeUndefined();
    expect(packageJson.exports["./session-store/file"]).toBeUndefined();
  });

  it("declares the Cloudflare adapter as a platform implementation subpath", async () => {
    const packageJson = await readRuntimePackageJson();

    expect(packageJson.exports["./platform/cloudflare"]).toMatchObject({
      "@minpeter/pss-source": "./src/platform/cloudflare/index.ts",
      import: "./dist/platform/cloudflare/index.js",
      types: "./dist/platform/cloudflare/index.d.ts",
    });
    expect(packageJson.exports["./cloudflare"]).toBeUndefined();
  });

  it("declares the Node adapter as a platform implementation subpath", async () => {
    const packageJson = await readRuntimePackageJson();

    expect(packageJson.exports["./platform/node"]).toMatchObject({
      "@minpeter/pss-source": "./src/platform/node/index.ts",
      import: "./dist/platform/node/index.js",
      types: "./dist/platform/node/index.d.ts",
    });
    expect(packageJson.exports["./node"]).toBeUndefined();
  });
});

async function readRuntimePackageJson(): Promise<RuntimePackageJson> {
  const packageJsonText = await readFile(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    "utf8"
  );
  return parseRuntimePackageJson(JSON.parse(packageJsonText));
}

function parseRuntimePackageJson(value: unknown): RuntimePackageJson {
  if (!(isRecord(value) && isRecord(value.exports))) {
    throw new TypeError("Expected runtime package.json exports object");
  }

  const exports: Record<string, RuntimeExport> = {};
  for (const [subpath, exportValue] of Object.entries(value.exports)) {
    if (!isRuntimeExport(exportValue)) {
      throw new TypeError(`Expected runtime export object for ${subpath}`);
    }
    exports[subpath] = exportValue;
  }
  return { exports };
}

function isRuntimeExport(value: unknown): value is RuntimeExport {
  return (
    isRecord(value) &&
    typeof value["@minpeter/pss-source"] === "string" &&
    (value.import === undefined || typeof value.import === "string") &&
    (value.types === undefined || typeof value.types === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
