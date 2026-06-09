import { describe, expect, it } from "vitest";
import { readNodeWebToolsEnv } from "./node.js";
import { readWorkerWebToolsEnv } from "./worker.js";

describe("web tools env presets", () => {
  it("readWorkerWebToolsEnv uses keyless opensearch defaults", () => {
    expect(readWorkerWebToolsEnv()).toEqual({});
  });

  it("readNodeWebToolsEnv uses keyless opensearch defaults", () => {
    expect(readNodeWebToolsEnv()).toEqual({});
  });
});