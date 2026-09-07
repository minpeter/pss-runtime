import { createSpinnerTicker, stylePendingIndicator } from "./pending-spinner";

export interface StartupStatusOutput {
  readonly columns?: number;
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

export async function withStartupStatus<T>(
  operation: () => Promise<T>,
  stdout: StartupStatusOutput = process.stdout
): Promise<T> {
  const stop = showStartupStatus(stdout);
  try {
    return await operation();
  } finally {
    stop();
  }
}

/** Minimal pre-mount status; relinquishes the line before pi-tui owns stdout. */
export function showStartupStatus(
  stdout: StartupStatusOutput = process.stdout
): () => void {
  if (!stdout.isTTY) {
    return () => undefined;
  }
  const ticker = createSpinnerTicker((frame) => {
    const width = Math.max(1, stdout.columns ?? 80);
    const label = "Starting...".slice(0, Math.max(0, width - 2));
    stdout.write(
      `\r\x1b[2K${label ? stylePendingIndicator(frame, label) : frame}`
    );
  });
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    ticker.stop();
    stdout.write("\r\x1b[2K");
  };
}
