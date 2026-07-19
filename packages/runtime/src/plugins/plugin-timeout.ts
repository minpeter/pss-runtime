import type { PluginEventMap } from "./api";

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  options: { readonly abortOnSignal?: boolean } = {}
): Promise<T> {
  const abortOnSignal = options.abortOnSignal ?? true;
  if (abortOnSignal && signal.aborted) {
    throw signal.reason ?? new Error("Aborted");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Plugin operation timed out.")),
      timeoutMs
    );
    if (abortOnSignal) {
      abort = () => reject(signal.reason ?? new Error("Aborted"));
      signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (abort) {
      signal.removeEventListener("abort", abort);
    }
  }
}

export function isTerminalNotification(event: keyof PluginEventMap): boolean {
  return (
    event === "turn.abort" ||
    event === "turn.end" ||
    event === "turn.error" ||
    event === "turn.settled"
  );
}
