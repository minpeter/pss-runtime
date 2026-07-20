import { noopRuntimeDiagnostics } from "../../plugins/diagnostics";
import { PluginRuntime } from "../../plugins/plugin-runtime";
import { Agent } from "./agent";
import {
  assertAgentOptions,
  type CreateAgentOptions,
  normalizePluginTimeoutOptions,
} from "./options";

export async function createAgent(options: CreateAgentOptions): Promise<Agent> {
  assertAgentOptions(options);
  const definitions = options.plugins ?? [];
  if (definitions.length === 0) {
    return new Agent(options);
  }
  const timeouts = normalizePluginTimeoutOptions(options);
  const runtime = await PluginRuntime.create(definitions, {
    diagnostics: options.host?.diagnostics ?? noopRuntimeDiagnostics,
    ...timeouts,
    tools: options.tools,
  });
  try {
    return new Agent(options, runtime);
  } catch (cause) {
    await runtime.dispose();
    throw cause;
  }
}
