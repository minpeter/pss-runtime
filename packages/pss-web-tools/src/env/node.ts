import type { WebToolsEnvironment } from "./types.js";

export function readNodeWebToolsEnv(): WebToolsEnvironment {
  return {
    EXA_API_KEY: process.env.EXA_API_KEY,
  };
}
