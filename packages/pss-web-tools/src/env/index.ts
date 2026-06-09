export type { WebToolsEnvironment } from "./types.js";

import type { WebToolsEnvironment } from "./types.js";

export function readNodeWebToolsEnv(): WebToolsEnvironment {
  return {
    EXA_API_KEY: process.env.EXA_API_KEY,
  };
}

export function readWorkerWebToolsEnv(
  bindings?: WebToolsEnvironment
): WebToolsEnvironment {
  return {
    EXA_API_KEY: bindings?.EXA_API_KEY,
  };
}
