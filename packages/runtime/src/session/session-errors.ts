import type { AgentHooks } from "../hooks";

export async function runAfterTurnHook(
  hooks: AgentHooks | undefined,
  context: Parameters<NonNullable<AgentHooks["afterTurn"]>>[0]
): Promise<void> {
  const hook = hooks?.afterTurn;
  if (!hook) {
    return;
  }

  await Promise.allSettled([Promise.resolve().then(() => hook(context))]);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function sessionKilledError(): Error {
  return new Error("Session killed");
}

export function sessionDeleteInProgressError(): Error {
  return new Error("Session delete in progress");
}

export function sessionTerminalError(killed: boolean): Error {
  return killed ? sessionKilledError() : sessionDeleteInProgressError();
}
