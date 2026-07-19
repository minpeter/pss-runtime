import type { ModelMessage } from "ai";
import {
  compactionContextForModel,
  type ThreadContextMessage,
} from "../thread/state/context";
import type { ModelPrompt } from "./model-step-types";

export function snapshotModelHistory(
  history: readonly ThreadContextMessage[]
): readonly ThreadContextMessage[] {
  if (!Array.isArray(history)) {
    throw new TypeError("history must be an array of model messages.");
  }
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(history, "length");
  } catch {
    throw new TypeError("history has an invalid length descriptor.");
  }
  if (
    !(
      lengthDescriptor &&
      "value" in lengthDescriptor &&
      typeof lengthDescriptor.value === "number" &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= 0
    )
  ) {
    throw new TypeError("history has an invalid length.");
  }
  const snapshot: ThreadContextMessage[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(history, String(index));
    } catch {
      throw new TypeError("history contains an invalid message descriptor.");
    }
    if (!(descriptor && "value" in descriptor)) {
      throw new TypeError(
        "history must be a dense array of data-property model messages."
      );
    }
    snapshot.push(descriptor.value as ThreadContextMessage);
  }
  return Object.freeze(snapshot);
}

export function promptForModel({
  history,
  instructions,
}: {
  readonly history: readonly ThreadContextMessage[];
  readonly instructions?: string;
}): ModelPrompt {
  const messages: ModelMessage[] = [];
  const systemContents: string[] = instructions ? [instructions] : [];
  for (const message of history) {
    if (message.role === "compaction") {
      messages.push(compactionContextForModel(message));
      continue;
    }
    if (message.role === "system") {
      systemContents.push(systemContentText(message.content));
      continue;
    }
    messages.push(message);
  }

  return {
    ...(systemContents.length === 0
      ? {}
      : { instructions: systemContents.join("\n\n") }),
    messages,
  };
}

function systemContentText(content: ModelMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content);
}
