import type { ToolSet } from "ai";
import { createWebTools } from "@minpeter/pss-web-tools";
import { readNodeWebToolsEnv } from "@minpeter/pss-web-tools/env";

const { tools: defaultTools } = createWebTools({
  env: readNodeWebToolsEnv(),
});

export const tools = defaultTools satisfies ToolSet;

export type DefaultTools = typeof tools;