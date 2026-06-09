import { describe, expect, it } from "vitest";
import { MissingExaApiKeyError, resolveExaApiKey } from "./exa.js";
import { readNodeWebToolsEnv } from "./node.js";
import { readWorkerWebToolsEnv } from "./worker.js";

describe("web tools env presets", () => {
  it("readWorkerWebToolsEnv passes through EXA_API_KEY", () => {
    expect(
      readWorkerWebToolsEnv({
        EXA_API_KEY: "worker-key",
      })
    ).toEqual({
      EXA_API_KEY: "worker-key",
    });
  });

  it("readNodeWebToolsEnv reads EXA_API_KEY from process.env", () => {
    const previous = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "node-key";

    expect(readNodeWebToolsEnv()).toEqual({
      EXA_API_KEY: "node-key",
    });

    if (previous === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = previous;
    }
  });

  it("resolveExaApiKey requires EXA_API_KEY", () => {
    expect(() => resolveExaApiKey({})).toThrow(MissingExaApiKeyError);
    expect(resolveExaApiKey({ EXA_API_KEY: "secret-key" })).toBe("secret-key");
  });
});
