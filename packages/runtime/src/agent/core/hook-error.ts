export class AgentHookError extends Error {
  readonly hook: keyof import("./hooks").AgentHooks;
  readonly modelOutput?: readonly import("ai").ModelMessage[];

  constructor(
    hook: keyof import("./hooks").AgentHooks,
    cause: unknown,
    modelOutput?: readonly import("ai").ModelMessage[]
  ) {
    super(`Agent hook "${hook}" failed`, { cause });
    this.name = "AgentHookError";
    this.hook = hook;
    if (modelOutput) {
      this.modelOutput = modelOutput;
    }
  }
}
