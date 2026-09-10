import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTRIBUTING,
  docsProblems,
  evidenceIgnoreProblems,
  HARNESS,
  harnessProblems,
  PREVIEW_COMMAND,
  PREVIEW_ENTRYPOINT,
  packageProblems,
  previewProblems,
  QA_META_MARKER,
  STATE_MARKER,
  tuiQaHarnessProblems,
} from "./tui-qa-harness.mjs";

// TUI visual-QA harness agreement (VAL-CROSS-012): the xterm.js harness
// keeps its no-new-service shape, CONTRIBUTING documents the concrete
// fixture (entrypoint, state, evidence root, no-port/no-credential
// contract), and the documented entrypoint still emits the marker and
// banner the harness relies on. Static; mutations are in-memory only.

const realRead = (path) => readFileSync(path, "utf8");

const VALID_DOC = [
  `Run \`node ${HARNESS}\` to render the TUI fixture.`,
  `The documented fixture is the \`${PREVIEW_COMMAND}\` entrypoint.`,
  `The documented state is the ${STATE_MARKER}.`,
  "--evidence-dir .omo/evidence/tui-visual-qa",
  "The run opens no listening port that outlives it.",
  "It needs no credential or network access.",
].join("\n");

const VALID_PACKAGE = {
  scripts: {
    [PREVIEW_COMMAND]:
      "tsx --conditions=@minpeter/pss-source scripts/preview-assistant-render.ts",
  },
};

const VALID_PREVIEW = [
  `process.stdout.write("${STATE_MARKER} — width " + width);`,
  `process.stdout.write(\`${QA_META_MARKER}\${JSON.stringify(metadata)}\\n\`);`,
].join("\n");

describe("TUI visual-QA harness agreement (VAL-CROSS-012)", () => {
  it("shipped harness, docs, entrypoint, and ignore rules agree", () => {
    expect(tuiQaHarnessProblems()).toEqual([]);
  });

  it("the shipped harness keeps its no-new-service shape", () => {
    expect(harnessProblems(realRead(HARNESS))).toEqual([]);
  });

  it("flags a harness that binds a fixed port or a non-loopback listen", () => {
    const real = realRead(HARNESS);
    expect(
      harnessProblems(
        real.replace('listen(0, "127.0.0.1"', 'listen(8080, "127.0.0.1"')
      ).join("\n")
    ).toContain("8080");
    expect(
      harnessProblems(
        real.replace('listen(0, "127.0.0.1"', 'listen(0, "127.0.1.1"')
      ).join("\n")
    ).toContain("ephemeral loopback");
  });

  it("flags a harness that drops teardown, receipts, or the evidence arg", () => {
    const real = realRead(HARNESS);
    expect(
      harnessProblems(real.replace("server.close(", "server.shut(")).join("\n")
    ).toContain("closes the page server");
    expect(
      harnessProblems(real.replace("teardown.json", "done.json")).join("\n")
    ).toContain("teardown.json");
    expect(
      harnessProblems(real.replaceAll('"evidence-dir"', '"out"')).join("\n")
    ).toContain("--evidence-dir");
    expect(
      harnessProblems(
        real.replace("Object.values(teardown).every(Boolean)", "true")
      ).join("\n")
    ).toContain("clean teardown");
  });

  it("flags a harness that injects a credential-shaped env key", () => {
    const real = realRead(HARNESS);
    expect(harnessProblems(`${real}\n// AI_API_KEY\n`).join("\n")).toContain(
      "AI_API_KEY"
    );
  });

  it("flags a missing harness", () => {
    expect(harnessProblems(null)).toEqual([`${HARNESS} is missing`]);
  });

  it("flags docs that drop the fixture, state, evidence root, or contract", () => {
    expect(docsProblems(VALID_DOC)).toEqual([]);
    expect(
      docsProblems(VALID_DOC.replace(`node ${HARNESS}`, "node qa.mjs")).length
    ).toBeGreaterThan(0);
    expect(
      docsProblems(VALID_DOC.replace(PREVIEW_COMMAND, "preview:other")).length
    ).toBeGreaterThan(0);
    expect(
      docsProblems(VALID_DOC.replace(STATE_MARKER, "some screen")).length
    ).toBeGreaterThan(0);
    expect(
      docsProblems(VALID_DOC.replace(".omo/evidence/tui-visual-qa", "./out"))
        .length
    ).toBeGreaterThan(0);
    expect(
      docsProblems(VALID_DOC.replace("no listening port", "a port")).length
    ).toBeGreaterThan(0);
    expect(
      docsProblems(VALID_DOC.replace("no credential", "a credential")).length
    ).toBeGreaterThan(0);
    expect(docsProblems(undefined)).toEqual([`${CONTRIBUTING} is missing`]);
  });

  it("flags a package that loses the documented entrypoint script", () => {
    expect(packageProblems(VALID_PACKAGE)).toEqual([]);
    expect(packageProblems({ scripts: {} })).not.toEqual([]);
    expect(
      packageProblems({
        scripts: { [PREVIEW_COMMAND]: "tsx scripts/other-preview.ts" },
      })
    ).not.toEqual([]);
  });

  it("flags an entrypoint that loses the marker or the state banner", () => {
    expect(previewProblems(VALID_PREVIEW)).toEqual([]);
    expect(
      previewProblems(VALID_PREVIEW.replace(QA_META_MARKER, "MARKER"))
    ).not.toEqual([]);
    expect(
      previewProblems(VALID_PREVIEW.replace(STATE_MARKER, "banner"))
    ).not.toEqual([]);
    expect(previewProblems(null)).toEqual([`${PREVIEW_ENTRYPOINT} is missing`]);
  });

  it("keeps harness evidence gitignored", () => {
    expect(evidenceIgnoreProblems()).toEqual([]);
  });
});
