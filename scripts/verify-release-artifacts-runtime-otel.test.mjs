import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseArtifacts } from "./verify-release-artifacts/core.mjs";
import {
  cleanupFixtures,
  createFixture,
} from "./verify-release-artifacts.fixture.mjs";

afterEach(cleanupFixtures);

function runtimeOtelDeclaration(cwd) {
  return join(cwd, "packages", "runtime", "dist", "otel", "index.d.ts");
}

describe("verifyReleaseArtifacts runtime OpenTelemetry declaration checks", () => {
  it("requires the runtime otel declaration entrypoint", () => {
    const cwd = createFixture();
    rmSync(runtimeOtelDeclaration(cwd));

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/otel/index.d.ts: missing otel runtime declaration",
    ]);
  });

  it("checks required OpenTelemetry adapter exports", () => {
    const cwd = createFixture();
    writeFileSync(runtimeOtelDeclaration(cwd), "export {};\n");

    expect(verifyReleaseArtifacts({ cwd, packages: ["runtime"] })).toEqual([
      "packages/runtime/dist/otel/index.d.ts: missing explicit otel runtime export TraceAgentTurnEventAttributes",
      "packages/runtime/dist/otel/index.d.ts: missing explicit otel runtime export TraceAgentTurnOptions",
      "packages/runtime/dist/otel/index.d.ts: missing explicit otel runtime export TraceAgentTurnSpan",
      "packages/runtime/dist/otel/index.d.ts: missing explicit otel runtime export TraceAgentTurnTracer",
      "packages/runtime/dist/otel/index.d.ts: missing explicit otel runtime export traceAgentTurn",
    ]);
  });
});
