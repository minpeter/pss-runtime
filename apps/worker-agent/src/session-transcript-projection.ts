import { z } from "zod";

import type { SessionTranscriptMessage } from "./session-transcript";
import { SEND_MESSAGE_TOOL_NAME } from "./tools";

const TextContentPartSchema = z
  .object({
    text: z.string(),
    type: z.literal("text"),
  })
  .passthrough();

const SendMessageToolCallPartSchema = z
  .object({
    input: z
      .object({
        text: z.string(),
      })
      .passthrough(),
    toolName: z.literal(SEND_MESSAGE_TOOL_NAME),
    type: z.literal("tool-call"),
  })
  .passthrough();

const ModelMessageSchema = z
  .object({
    content: z.unknown(),
    role: z.enum(["assistant", "system", "tool", "user"]),
  })
  .passthrough();

const ThreadCompactionSchema = z
  .object({
    endSeqExclusive: z.number().int().positive(),
    schemaVersion: z.literal(1),
    startSeq: z.number().int().nonnegative(),
    summary: ModelMessageSchema,
  })
  .passthrough();

const ThreadSnapshotSchema = z.discriminatedUnion("schemaVersion", [
  z
    .object({
      history: z.array(ModelMessageSchema).readonly(),
      schemaVersion: z.literal(1),
    })
    .passthrough(),
  z
    .object({
      compactions: z.array(ThreadCompactionSchema).readonly(),
      history: z.array(ModelMessageSchema).readonly(),
      schemaVersion: z.literal(2),
    })
    .passthrough(),
]);

export function extractSessionTranscriptMessages(
  state: unknown
): readonly SessionTranscriptMessage[] {
  return transcriptMessages(
    modelContextMessages(ThreadSnapshotSchema.parse(state))
  );
}

function modelContextMessages(
  snapshot: z.infer<typeof ThreadSnapshotSchema>
): readonly z.infer<typeof ModelMessageSchema>[] {
  if (snapshot.schemaVersion === 1 || snapshot.compactions.length === 0) {
    return snapshot.history;
  }

  const compactions = nonOverlappedCompactions(
    snapshot.history.length,
    snapshot.compactions
  );
  const byStart = new Map(
    compactions.map((record) => [record.startSeq, record])
  );
  const output: z.infer<typeof ModelMessageSchema>[] = [];
  for (let index = 0; index < snapshot.history.length; ) {
    const compaction = byStart.get(index);
    if (compaction) {
      output.push(compaction.summary);
      index = compaction.endSeqExclusive;
      continue;
    }
    const message = snapshot.history[index];
    if (message) {
      output.push(message);
    }
    index += 1;
  }
  return output;
}

function nonOverlappedCompactions(
  historyLength: number,
  records: readonly z.infer<typeof ThreadCompactionSchema>[]
): readonly z.infer<typeof ThreadCompactionSchema>[] {
  const kept: z.infer<typeof ThreadCompactionSchema>[] = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || record.endSeqExclusive > historyLength) {
      continue;
    }
    if (kept.some((keptRecord) => overlaps(record, keptRecord))) {
      continue;
    }
    kept.push(record);
  }
  return kept.sort((left, right) => left.startSeq - right.startSeq);
}

function overlaps(
  left: z.infer<typeof ThreadCompactionSchema>,
  right: z.infer<typeof ThreadCompactionSchema>
): boolean {
  return (
    left.startSeq < right.endSeqExclusive &&
    right.startSeq < left.endSeqExclusive
  );
}

function transcriptMessages(
  messages: readonly z.infer<typeof ModelMessageSchema>[]
): readonly SessionTranscriptMessage[] {
  const transcript: SessionTranscriptMessage[] = [];
  for (const message of messages) {
    const text = messageText(message);
    if (!text) {
      continue;
    }
    transcript.push({
      index: transcript.length,
      role: message.role === "assistant" ? "assistant" : "user",
      text,
    });
  }
  return transcript;
}

function messageText(
  message: z.infer<typeof ModelMessageSchema>
): string | undefined {
  switch (message.role) {
    case "assistant":
      return textFromContent(message.content, {
        includeSendMessageCalls: true,
      });
    case "user":
      return textFromContent(message.content, {
        includeSendMessageCalls: false,
      });
    case "system":
    case "tool":
      return;
    default:
      return assertNever(message.role);
  }
}

function textFromContent(
  content: unknown,
  options: { readonly includeSendMessageCalls: boolean }
): string | undefined {
  if (typeof content === "string") {
    return normalizeTranscriptText([content]);
  }
  if (!Array.isArray(content)) {
    return;
  }

  const text: string[] = [];
  for (const part of content) {
    const sendMessage = options.includeSendMessageCalls
      ? SendMessageToolCallPartSchema.safeParse(part)
      : undefined;
    if (sendMessage?.success) {
      text.push(sendMessage.data.input.text);
      continue;
    }

    const textPart = TextContentPartSchema.safeParse(part);
    if (textPart.success) {
      text.push(textPart.data.text);
    }
  }
  return normalizeTranscriptText(text);
}

function normalizeTranscriptText(
  values: readonly string[]
): string | undefined {
  const text = values
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function assertNever(value: never): never {
  throw new SessionTranscriptProjectionError(
    `Unexpected session transcript message role: ${String(value)}`
  );
}

class SessionTranscriptProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTranscriptProjectionError";
  }
}
