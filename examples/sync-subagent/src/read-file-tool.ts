import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonSchema, tool } from "ai";

const fixturesRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures"
);

interface ReadFileInput {
  readonly path: string;
}

export function createReadFileTool() {
  return tool<ReadFileInput, string, Record<string, unknown>>({
    description:
      "Example fixtures/kb Read the text file from the knowledgebase. The path is fixtures/ must be below.",
    execute: async ({ path }) => {
      const resolvedPath = resolve(fixturesRoot, path);
      const insideFixtures =
        resolvedPath === fixturesRoot ||
        resolvedPath.startsWith(`${fixturesRoot}${sep}`);
      if (!insideFixtures) {
        throw new Error("Path must stay inside the fixtures directory.");
      }

      return await readFile(resolvedPath, "utf8");
    },
    inputSchema: jsonSchema<ReadFileInput>({
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: 'fixtures/ Relative path below. Yes: "kb/pricing.md".',
        },
      },
      required: ["path"],
      type: "object",
    }),
  });
}
