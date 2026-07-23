import { type LanguageModel, wrapLanguageModel } from "ai";
import type { PluginRequestResultMap, ProviderCallOptions } from "./api";
import {
  invokeHandler,
  notifyHandlers,
  throwHookFailure,
  validateRequestResult,
} from "./plugin-invocation";
import { activeHandlers } from "./plugin-registry";
import type { PluginRuntimeState } from "./plugin-types";

export function wrapRuntimeModel(
  state: PluginRuntimeState,
  model: LanguageModel,
  threadKey: string
): Exclude<LanguageModel, string> {
  const wrapped = wrapLanguageModel({
    middleware: {
      transformParams: async ({ params }) =>
        await transformProviderParams(state, threadKey, params),
      wrapGenerate: async ({ doGenerate }) => {
        const response = await doGenerate();
        await notifyProviderResponse(state, threadKey, response);
        return response;
      },
      wrapStream: async ({ doStream }) => {
        const response = await doStream();
        await notifyProviderResponse(state, threadKey, response);
        return response;
      },
    },
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
  });
  if (!hasDoStream(model)) {
    Object.defineProperty(wrapped, "doStream", {
      configurable: true,
      value: undefined,
      writable: true,
    });
  }
  return wrapped;
}

function hasDoStream(model: LanguageModel): boolean {
  return (
    typeof model === "object" &&
    model !== null &&
    typeof (model as { readonly doStream?: unknown }).doStream === "function"
  );
}

async function transformProviderParams(
  state: PluginRuntimeState,
  threadKey: string,
  params: ProviderCallOptions
): Promise<ProviderCallOptions> {
  let current = params;
  for (const { registered, registration } of activeHandlers(
    state,
    "provider.request.before"
  )) {
    const signal = params.abortSignal ?? state.abort.signal;
    const result = await invokeHandler(
      state,
      registration,
      "provider.request.before",
      registered,
      { params: current },
      { history: [], signal, threadKey }
    );
    const decision = result as
      | PluginRequestResultMap["provider.request.before"]
      | undefined;
    await validateRequestResult(
      state,
      registration,
      "provider.request.before",
      decision,
      ["continue", "transform"]
    );
    if (decision?.action === "transform") {
      try {
        assertProviderBeforeRequestEvent(decision.value);
      } catch (cause) {
        await throwHookFailure(
          state,
          registration,
          "provider.request.before",
          cause
        );
      }
      current = decision.value.params;
    }
  }
  return current;
}

function assertProviderBeforeRequestEvent(
  value: unknown
): asserts value is { readonly params: ProviderCallOptions } {
  if (
    !(
      value &&
      typeof value === "object" &&
      "params" in value &&
      value.params &&
      typeof value.params === "object"
    )
  ) {
    throw new TypeError(
      "Plugin provider.request.before transform must return provider params."
    );
  }
}

function notifyProviderResponse(
  state: PluginRuntimeState,
  threadKey: string,
  response: unknown
): Promise<void> {
  return notifyHandlers(
    state,
    "provider.response.after",
    { response },
    { history: [], signal: state.abort.signal, threadKey }
  );
}
