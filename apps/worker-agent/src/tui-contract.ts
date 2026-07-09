import { z } from "zod";

import { ChannelAddressSchema } from "./channel";

export const TUI_SESSION_SCOPE_KEY = "tui:local-user";

export const TuiTurnInputSchema = z
  .object({
    channel: ChannelAddressSchema,
    sessionScopeKey: z.string().optional(),
    text: z.string(),
  })
  .strict();

export const TuiTurnOutputSchema = z.discriminatedUnion("delivered", [
  z
    .object({
      delivered: z.literal(true),
      mode: z.enum(["send", "steer"]).optional(),
      messages: z
        .array(
          z
            .object({
              channel: z.string(),
              messageId: z.string(),
              text: z.string(),
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
      mode: z.enum(["send", "steer"]).optional(),
    })
    .strict(),
]);

export type TuiTurnInput = z.infer<typeof TuiTurnInputSchema>;
export type TuiTurnOutput = z.infer<typeof TuiTurnOutputSchema>;
