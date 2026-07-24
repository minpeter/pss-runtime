import type {
  CodingAgentExtension,
  CodingAgentExtensionActivationHandler,
  CodingAgentExtensionCleanup,
  CodingAgentExtensionInput,
  CodingAgentExtensionModule,
} from "./types";

export function normalizeCodingAgentExtension(
  input: CodingAgentExtensionInput
): CodingAgentExtension {
  if ("configure" in input) {
    return input;
  }
  if (typeof input.default !== "function") {
    throw new TypeError(
      `Coding agent extension "${input.id}" default export must be a function`
    );
  }
  return factoryModuleToExtension(input);
}

function factoryModuleToExtension(
  extensionModule: CodingAgentExtensionModule
): CodingAgentExtension {
  const activationHandlers: CodingAgentExtensionActivationHandler[] = [];
  return {
    id: extensionModule.id,
    async configure(registry) {
      let open = true;
      try {
        await extensionModule.default({
          ...registry,
          id: extensionModule.id,
          lifecycle: {
            onActivate(handler) {
              if (!open) {
                throw new Error(
                  `Coding agent extension "${extensionModule.id}" registration is closed`
                );
              }
              activationHandlers.push(handler);
            },
          },
        });
      } finally {
        open = false;
      }
    },
    async activate(context) {
      const cleanups: CodingAgentExtensionCleanup[] = [];
      try {
        for (const handler of activationHandlers) {
          const cleanup = await handler(context);
          if (cleanup) {
            cleanups.push(cleanup);
          }
        }
      } catch (error) {
        await disposeCleanups(cleanups);
        throw error;
      }
      return async () => {
        await disposeCleanups(cleanups);
      };
    },
  };
}

async function disposeCleanups(
  cleanups: readonly CodingAgentExtensionCleanup[]
): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Coding agent extension cleanup failed");
  }
}
