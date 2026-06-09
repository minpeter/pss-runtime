import type { AgentEvent, RuntimeInput } from "./events";
import type { InputEventMeta } from "./input-meta-types";
import type { UserInput, UserMessage, UserText } from "./input";

export type { InputEventMeta, InputSource } from "./input-meta-types";

export function attachInputMeta(
  input: UserInput,
  meta: InputEventMeta
): UserText | UserMessage {
  if (input.type === "user-text") {
    return { ...input, meta };
  }

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
  if (input.type === "user-text") {
    const { meta: _meta, ...rest } = input;
    return rest;
  }

  const { meta: _meta, ...rest } = input;
  return rest;
}

export function stripEventMeta(event: AgentEvent): AgentEvent {
  if (event.type === "user-text" || event.type === "user-message") {
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

export function userInputFromEvent(
  event: UserText | UserMessage
): UserInput {
  return stripInputMeta(event);
}