import { applyEdits } from "@oh-my-pi/hashline/apply";
import { parsePatch } from "@oh-my-pi/hashline/parser";
import {
  enclosingBoundaries,
  nodeChain,
  parsesCleanly,
} from "@oh-my-pi/hashline/syntax";
import { describe, expect, it } from "vitest";

const source = "function f() {\n  return 1;\n}\n";
const path = "example.ts";

describe("hashline Node compatibility with the real native parser", () => {
  it("parses source and isolates same-length cache entries by content and path", () => {
    const invalid = source.replace("}", "]");
    expect(invalid.length).toBe(source.length);
    for (const text of [source, invalid, source]) {
      expect(parsesCleanly(path, text)).toBe(text === source);
    }
    expect(parsesCleanly("example.unknown-language", source)).toBe(false);
    expect(parsesCleanly(path, source)).toBe(true);
  });

  it("retains native node-chain and boundary probes across cache hits", () => {
    const lines = source.split("\n");
    for (const line of [2, 4, 2]) {
      const chain = nodeChain(lines, path, line);
      if (line === 2) {
        expect(chain).toContainEqual({
          endLine: 3,
          kind: "function_declaration",
          startLine: 1,
        });
      } else {
        expect(chain).toEqual([]);
      }
    }
    for (const text of [source, source.replace("}", "]"), source]) {
      expect(enclosingBoundaries(text.split("\n"), path, 1, 2)).toEqual(
        text === source ? [3] : []
      );
    }
  });

  it("applies a parsed patch and repairs a syntax-essential closing boundary", () => {
    const edits = parsePatch("PUT 2.=3:\n+  return 2;").edits;
    const applied = applyEdits(source, edits, { path });
    expect(applied.text).toBe("function f() {\n  return 2;\n}\n");
    expect(applied.firstChangedLine).toBe(2);
    expect(applied.warnings).toHaveLength(1);
    expect(applyEdits(source, edits, { path })).toEqual(applied);
  });

  it("does not turn invalid line anchors into successful edits", () => {
    const edits = parsePatch("PUT 99.=99:\n+  return 2;").edits;
    expect(() => applyEdits(source, edits, { path })).toThrow();
  });
});
