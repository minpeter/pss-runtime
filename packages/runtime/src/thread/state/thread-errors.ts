export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function threadKilledError(): Error {
  return new Error("Thread killed");
}

export function threadDeleteInProgressError(): Error {
  return new Error("Thread delete in progress");
}

export function threadTerminalError(killed: boolean): Error {
  return killed ? threadKilledError() : threadDeleteInProgressError();
}
