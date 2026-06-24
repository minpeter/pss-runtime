import type { ThreadInspection } from "@minpeter/pss-runtime";

import type { TuiOutput } from "./tui-sink";

const INSPECT_COMMAND = "/inspect";

export interface DeliverTuiInspectOptions {
  readonly defaultKey: string;
  readonly inspect: (key: string) => Promise<ThreadInspection>;
  readonly output: TuiOutput;
  readonly text: string;
}

export function isTuiInspectCommand(text: string): boolean {
  return text === INSPECT_COMMAND || text.startsWith(`${INSPECT_COMMAND} `);
}

export function parseTuiInspectKey(text: string): string | undefined {
  if (!isTuiInspectCommand(text)) {
    return;
  }
  return text.slice(INSPECT_COMMAND.length).trim() || undefined;
}

export async function deliverTuiInspect({
  defaultKey,
  inspect,
  output,
  text,
}: DeliverTuiInspectOptions): Promise<void> {
  const key = parseTuiInspectKey(text) ?? defaultKey;
  const inspection = await inspect(key);
  for (const line of formatThreadInspection(inspection)) {
    output.writeLine(line);
  }
}

export function formatThreadInspection(
  inspection: ThreadInspection
): readonly string[] {
  if (!inspection.exists) {
    return [`inspect ${inspection.threadKey}: no stored session`];
  }

  const lines = [
    `inspect ${inspection.threadKey}:`,
    `  version: ${inspection.version ?? "unknown"}`,
    `  messages: ${inspection.messageCount}`,
    `  compactions: ${inspection.compactionCount}`,
    `  summary bytes: ${inspection.summaryBytes}`,
  ];
  for (const compaction of inspection.compactions) {
    lines.push(
      `  compaction [${compaction.startSeq}, ${compaction.endSeqExclusive}) ${compaction.summaryBytes}B`
    );
  }
  return lines;
}
