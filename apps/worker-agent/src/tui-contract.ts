import { z } from "zod";

import { ChannelAddressSchema } from "./channel";

export const ThreadInspectionSchema = z
  .object({
    compactionCount: z.number().int().nonnegative(),
    compactions: z
      .array(
        z
          .object({
            endSeqExclusive: z.number().int().nonnegative(),
            startSeq: z.number().int().nonnegative(),
            summaryBytes: z.number().int().nonnegative(),
          })
          .strict()
      )
      .readonly(),
    exists: z.boolean(),
    messageCount: z.number().int().nonnegative(),
    summaryBytes: z.number().int().nonnegative(),
    threadKey: z.string(),
    version: z.string().nullable(),
  })
  .strict();

export const TuiInspectInputSchema = z
  .object({
    conversationKey: z.string(),
  })
  .strict();

export const TuiInspectOutputSchema = ThreadInspectionSchema;

export const TuiTurnInputSchema = z
  .object({
    channel: ChannelAddressSchema,
    text: z.string(),
  })
  .strict();

export const TuiTurnOutputSchema = z.discriminatedUnion("delivered", [
  z
    .object({
      delivered: z.literal(true),
      messages: z
        .array(
          z
            .object({
              messageId: z.string(),
              text: z.string(),
              threadId: z.string(),
            })
            .strict()
        )
        .readonly()
        .optional(),
    })
    .strict(),
  z
    .object({
      delivered: z.literal(false),
      error: z.literal("missing_send_message"),
    })
    .strict(),
]);

export type TuiTurnInput = z.infer<typeof TuiTurnInputSchema>;
export type TuiTurnOutput = z.infer<typeof TuiTurnOutputSchema>;
export type TuiInspectInput = z.infer<typeof TuiInspectInputSchema>;
export type TuiInspectOutput = z.infer<typeof TuiInspectOutputSchema>;
