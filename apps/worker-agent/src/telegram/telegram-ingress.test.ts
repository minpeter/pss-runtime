import { describe, expect, it } from "vitest";

import { summarizeIngressBatch } from "./telegram-ingress";

const META = { key: "chat-1", subscribe: false } as const;

function previewFor(text: string): string {
  return summarizeIngressBatch([{ text }], META).textPreview;
}

describe("summarizeIngressBatch text preview boundary", () => {
  it("logs text of exactly 80 characters in full", () => {
    const text = "a".repeat(80);
    const summary = summarizeIngressBatch([{ text }], META);
    expect(summary.textPreview).toBe(text);
    expect(summary.textChars).toBe(80);
  });

  it("logs text shorter than 80 characters in full", () => {
    const text = "short preview text";
    expect(previewFor(text)).toBe(text);
  });

  it("truncates 81 characters to the first 77 plus an ellipsis suffix", () => {
    const text = "b".repeat(81);
    const preview = previewFor(text);
    expect(preview).toBe(`${"b".repeat(77)}...`);
    expect(preview).toHaveLength(80);
  });

  it("trims trailing whitespace at the cut before suffixing the ellipsis", () => {
    // slice(0, 77) ends inside the space run, so trimEnd must fire and the
    // result is shorter than 80 with no trailing space before `...`.
    const text = `${"x".repeat(75)}   ${"y".repeat(20)}`;
    const preview = previewFor(text);
    expect(preview).toBe(`${"x".repeat(75)}...`);
    expect(preview).toHaveLength(78);
    expect(preview.endsWith(" ...")).toBe(false);
  });

  it("keeps the preview at most 80 characters across input lengths", () => {
    for (const length of [0, 1, 79, 80, 81, 82, 120, 500, 5000]) {
      const preview = previewFor("c".repeat(length));
      expect(preview.length).toBeLessThanOrEqual(80);
    }
  });

  it("never leaks text beyond the cut into the preview", () => {
    const tail = "UNIQUE-TAIL-MARKER-9f2b";
    const text = `${"d".repeat(77)} ${tail}`;
    const preview = previewFor(text);
    expect(preview).not.toContain(tail);
    expect(preview).toBe(`${"d".repeat(77)}...`);
  });

  it("counts the joined multi-fragment text toward the same boundary", () => {
    const first = "e".repeat(50);
    const second = "f".repeat(50);
    const summary = summarizeIngressBatch(
      [{ text: first }, { text: second }],
      META
    );
    const joined = `${first}\n${second}`;
    expect(summary.textChars).toBe(joined.length);
    expect(joined.length).toBeGreaterThan(80);
    expect(summary.textPreview).toBe(`${joined.slice(0, 77)}...`);
    expect(summary.textPreview).toHaveLength(80);
  });

  it("returns an empty preview when no fragment carries text", () => {
    const summary = summarizeIngressBatch([{ text: undefined }], META);
    expect(summary.textPreview).toBe("");
    expect(summary.textChars).toBe(0);
  });
});
