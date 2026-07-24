import type {
  AgentCompactionDecision,
  AgentHooks,
  AgentInputDecision,
  AgentInputEvent,
  AgentTransformDecision,
  AgentTurnStartEvent,
} from "@minpeter/pss-runtime";
import { CodingAgentExtensionError } from "./error";

export interface RegisteredAgentHooks {
  readonly extensionId: string;
  readonly hooks: AgentHooks;
}

async function invoke<Result>(
  extensionId: string,
  callback: () => Promise<Result> | Result
): Promise<Result> {
  try {
    return await callback();
  } catch (error) {
    throw new CodingAgentExtensionError(extensionId, "hook", error);
  }
}

export function composeAgentHooks(
  registrations: readonly RegisteredAgentHooks[]
): AgentHooks {
  return {
    acceptInput: async (event, context) => {
      let current: AgentInputEvent = event;
      for (const registration of registrations) {
        const hook = registration.hooks.acceptInput;
        if (!hook) {
          continue;
        }
        const decision = await invoke(registration.extensionId, () =>
          hook(current, context)
        );
        if (decision?.action === "handled") {
          return decision;
        }
        if (decision?.action === "transform") {
          current = decision.value;
        }
      }
      return current === event
        ? undefined
        : ({
            action: "transform",
            value: current,
          } satisfies AgentInputDecision<AgentInputEvent>);
    },
    beforeCompaction: async (event, context) => {
      let current = event.input;
      for (const registration of registrations) {
        const hook = registration.hooks.beforeCompaction;
        if (!hook) {
          continue;
        }
        const decision = await invoke(registration.extensionId, () =>
          hook({ input: current }, context)
        );
        if (decision?.action === "cancel") {
          return decision;
        }
        if (decision?.action === "transform") {
          current = decision.input;
        }
      }
      return current === event.input
        ? undefined
        : ({
            action: "transform",
            input: current,
          } satisfies AgentCompactionDecision);
    },
    beforeToolExecution: async (checkpoint, context) => {
      let current = checkpoint;
      for (const registration of registrations) {
        const hook = registration.hooks.beforeToolExecution;
        if (!hook) {
          continue;
        }
        const decision = await invoke(registration.extensionId, () =>
          hook(current, context)
        );
        if (decision?.status === "blocked") {
          return decision;
        }
        if (decision?.status === "needs-recovery") {
          return decision;
        }
        if (decision?.status === "continue") {
          current = { ...current, input: decision.input };
        }
      }
      return current === checkpoint
        ? undefined
        : { input: current.input, status: "continue" };
    },
    beforeTurnStart: async (event, context) => {
      let current: AgentTurnStartEvent = event;
      for (const registration of registrations) {
        const hook = registration.hooks.beforeTurnStart;
        if (!hook) {
          continue;
        }
        const decision = await invoke(registration.extensionId, () =>
          hook(current, context)
        );
        if (decision?.action === "transform") {
          current = decision.value;
        }
      }
      return current === event
        ? undefined
        : ({
            action: "transform",
            value: current,
          } satisfies AgentTransformDecision<AgentTurnStartEvent>);
    },
    transformModelContext: async (event, context) => {
      let current = event.messages;
      for (const registration of registrations) {
        const hook = registration.hooks.transformModelContext;
        if (!hook) {
          continue;
        }
        const decision = await invoke(registration.extensionId, () =>
          hook({ messages: current }, context)
        );
        if (decision?.action === "transform") {
          current = decision.value;
        }
      }
      return current === event.messages
        ? undefined
        : { action: "transform", value: current };
    },
    transformModelStep: async (event, context) => {
      let current = event.output;
      for (const registration of registrations) {
        const hook = registration.hooks.transformModelStep;
        if (!hook) {
          continue;
        }
        const decision = await invoke(registration.extensionId, () =>
          hook({ output: current }, context)
        );
        if (decision?.action === "transform") {
          current = decision.value;
        }
      }
      return current === event.output
        ? undefined
        : { action: "transform", value: current };
    },
    transformToolResult: async (checkpoint, context) => {
      let current = checkpoint;
      for (const registration of registrations) {
        const hook = registration.hooks.transformToolResult;
        if (!hook) {
          continue;
        }
        const result = await invoke(registration.extensionId, () =>
          hook(current, context)
        );
        if (result !== undefined) {
          current = { ...current, output: result.output };
        }
      }
      return current === checkpoint ? undefined : { output: current.output };
    },
  };
}
