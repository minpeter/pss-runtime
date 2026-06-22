import type { AgentEvent, RuntimeInput } from "../protocol/events";
import type { UserInput } from "./input";
import type { InputEventMeta } from "./input-meta-types";

export type { InputEventMeta, InputSource } from "./input-meta-types";

export function attachInputMeta<T extends UserInput>(
  input: T,
  meta: InputEventMeta
): T & { readonly meta: InputEventMeta } {
  return { ...input, meta };
}

export function attachRuntimeInputMeta(
  input: UserInput,
  placement: RuntimeInput["placement"],
  meta: InputEventMeta
): RuntimeInput {
  return {
    input: attachInputMeta(input, meta),
    meta,
    placement,
    type: "runtime-input",
  };
}

export function stripInputMeta(input: UserInput): UserInput {
  const { meta: _meta, ...rest } = input;
  return rest;
}

export function stripEventMeta(event: AgentEvent): AgentEvent {
  if (event.type === "user-input") {
    return stripInputMeta(event);
  }

  if (event.type === "runtime-input") {
    const { meta: _meta, ...rest } = event;
    return {
      ...rest,
      input: stripInputMeta(event.input),
    };
  }

  return event;
}

export function userInputFromEvent(event: UserInput): UserInput {
  return stripInputMeta(event);
}
