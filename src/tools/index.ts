import type { ToolSet } from "ai";
import { continueTool } from "./continue";

export type AgentTools = ToolSet;

export const tools = { continue: continueTool } satisfies AgentTools;

export type DefaultTools = typeof tools;
