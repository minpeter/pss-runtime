import { Agent } from "@minpeter/pss-runtime";
import { realModel } from "./real-model";
import { createScriptedModel, type ScriptedResult } from "./scripted-model";
import { instructions, tools } from "./tools";

const REAL = process.env.PSS_EVAL_REAL === "1";

/**
 * Build a per-case agent thread. In scripted mode (default) the scripted
 * results drive one deterministic turn; in real mode (`PSS_EVAL_REAL=1`) the
 * same evals run against your configured model. Each call builds a fresh thread
 * so cases never share conversation state.
 */
export function evalThread(scriptedResults: readonly ScriptedResult[]) {
  const model = REAL ? realModel() : createScriptedModel(scriptedResults);
  return new Agent({ instructions, model, tools }).thread("eval");
}
