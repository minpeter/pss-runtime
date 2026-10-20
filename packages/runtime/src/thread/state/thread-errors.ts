export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export class DisposedResourceError extends Error {
  override readonly name = "DisposedResourceError";
}

export function threadKilledError(): DisposedResourceError {
  return new DisposedResourceError("Thread killed");
}
