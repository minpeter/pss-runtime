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

  it("does not expose legacy store implementation subpaths", async () => {
    const packageJson = await readRuntimePackageJson();

    expect(packageJson.exports["./thread-store/file"]).toBeUndefined();
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
    expect(packageJson.exports["./platform/cloudflare-agents"]).toBeUndefined();
    expect(packageJson.exports["./cloudflare"]).toBeUndefined();
    expect(packageJson.exports["./cloudflare-agents"]).toBeUndefined();
  });

  it("exports the combined Cloudflare platform facade from the canonical subpath", async () => {
    const cloudflarePlatform = await import("../platform/cloudflare");
    const canonicalCloudflareExports = [
      "createCloudflareHost",
      "createCloudflareStorageHost",
      "createCloudflareScheduledWorkScheduler",
      "createCloudflareAgentsFiberScheduler",
      "createCloudflarePlatformContext",
      "recoverCloudflareAgentsFiber",
      "startCloudflareAgentsResumeFiber",
      "drainAgentTurn",
    ] as const;

    for (const exportName of canonicalCloudflareExports) {
      expect(cloudflarePlatform).toHaveProperty(exportName);
    }
    expect(cloudflarePlatform).not.toHaveProperty("createCloudflareAgentsHost");
  });

  it("declares the file adapter as a platform implementation subpath", async () => {
    const packageJson = await readRuntimePackageJson();

    expect(packageJson.exports["./platform/file"]).toMatchObject({
      "@minpeter/pss-source": "./src/platform/file/index.ts",
      import: "./dist/platform/file/index.js",
      types: "./dist/platform/file/index.d.ts",
    });
    expect(packageJson.exports["./platform/node"]).toBeUndefined();
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
