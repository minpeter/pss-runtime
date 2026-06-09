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
      "예제 fixtures/kb 지식베이스에서 텍스트 파일을 읽는다. 경로는 fixtures/ 아래여야 한다.",
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
          description: 'fixtures/ 아래 상대 경로. 예: "kb/pricing.md".',
        },
      },
      required: ["path"],
      type: "object",
    }),
  });
}