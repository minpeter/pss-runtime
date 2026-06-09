import type { WebToolsEnvironment } from "./types.js";

export function readWorkerWebToolsEnv(
  bindings?: WebToolsEnvironment
): WebToolsEnvironment {
  return {
    EXA_API_KEY: bindings?.EXA_API_KEY,
  };
}
