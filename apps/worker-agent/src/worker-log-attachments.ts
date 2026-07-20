export function attachmentLogFields(
  attachments: readonly {
    readonly dataBase64: string;
    readonly mediaType: string;
  }[]
): {
  readonly attachments: {
    readonly count: number;
    readonly mediaTypes: readonly string[];
    readonly payloadBytes: number;
  };
} {
  return {
    attachments: {
      count: attachments.length,
      mediaTypes: attachments.map((attachment) => attachment.mediaType),
      // base64 length ≈ 4/3 of raw bytes; size signal without decoding.
      payloadBytes: attachments.reduce(
        (sum, attachment) =>
          sum + Math.floor((attachment.dataBase64.length * 3) / 4),
        0
      ),
    },
  };
}
