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
