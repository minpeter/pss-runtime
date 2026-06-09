import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts/core.mjs";
import {
  cleanupFixtures,
  createFixture,
} from "./verify-release-artifacts.fixture.mjs";

afterEach(cleanupFixtures);

const forbiddenNames = [
  ["Subagent", "Definition"].join(""),
  ["resume", "Background", "Child", "Run"].join(""),
  ["Background", "Child", "Agent"].join(""),
  ["Subagent", "Status", "Agent", "Event"].join(""),
  ["is", "Subagent", "Status", "Agent", "Event"].join(""),
  ["background", "Subagents"].join(""),
  ["background", "subagent"].join("-"),
  ["subagent", "job", "start"].join("-"),
  ["subagent", "job", "update"].join("-"),
  ["subagent", "job", "end"].join("-"),
  ["create", "Subagent", "Tools"].join(""),
  ["register", "Subagents"].join(""),
];

describe("verifyReleaseArtifacts runtime subagent checks", () => {
  it("rejects runtime-owned subagent names from runtime artifacts", () => {
    const cwd = createFixture();
    writeFileSync(
      join(cwd, "packages", "runtime", "dist", "subagents.d.ts"),
      forbiddenDeclarations()
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual(
      forbiddenNames.map(
        (name) =>
          `packages/runtime/dist/subagents.d.ts: exposes runtime-owned subagent name ${name}`
      )
    );
  });
});

function forbiddenDeclarations() {
  return [
    `export type ${forbiddenNames[0]} = {};`,
    `export declare const ${forbiddenNames[1]}: unknown;`,
    `export type ${forbiddenNames[2]} = {};`,
    `export type ${forbiddenNames[3]} = {};`,
    `export declare const ${forbiddenNames[4]}: unknown;`,
    `export declare const ${forbiddenNames[5]}: unknown;`,
    `export declare const kind: "${forbiddenNames[6]}";`,
    `export declare const eventType: "${forbiddenNames[7]}";`,
    `export declare const updateType: "${forbiddenNames[8]}";`,
    `export declare const endType: "${forbiddenNames[9]}";`,
    `export declare const ${forbiddenNames[10]}: unknown;`,
    `export declare const ${forbiddenNames[11]}: unknown;`,
    "",
  ].join("\n");
}
