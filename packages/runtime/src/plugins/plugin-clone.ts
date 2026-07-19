export function cloneEvent<T>(event: T): T {
  try {
    return structuredClone(event);
  } catch {
    return event;
  }
}

export function cloneToolCallInput(input: unknown): unknown {
  try {
    return structuredClone(input);
  } catch (cause) {
    throw new TypeError(
      "Plugin tool.call.before transform input must be structured-cloneable.",
      { cause }
    );
  }
}
