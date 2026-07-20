export class PluginInitializationError extends Error {
  readonly cause: unknown;
  readonly pluginIndex: number;

  constructor(pluginIndex: number, cause: unknown) {
    super(`Plugin at index ${pluginIndex} failed to initialize.`);
    this.name = "PluginInitializationError";
    this.pluginIndex = pluginIndex;
    this.cause = cause;
  }
}

export class PluginHookError extends Error {
  readonly cause: unknown;
  readonly event: string;
  readonly pluginIndex: number;

  constructor(pluginIndex: number, event: string, cause: unknown) {
    super(`Plugin at index ${pluginIndex} failed handling ${event}.`);
    this.name = "PluginHookError";
    this.pluginIndex = pluginIndex;
    this.event = event;
    this.cause = cause;
  }
}

export class PluginRegistrationClosedError extends Error {
  readonly pluginIndex: number;

  constructor(pluginIndex: number) {
    super(
      `Plugin at index ${pluginIndex} attempted to register after its factory completed.`
    );
    this.name = "PluginRegistrationClosedError";
    this.pluginIndex = pluginIndex;
  }
}
