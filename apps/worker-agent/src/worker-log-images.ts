export function summarizeImagePrepares(
  prepares: readonly {
    readonly path: string;
    readonly inputBytes: number;
    readonly outputBytes: number;
    readonly inputMediaType: string;
    readonly outputMediaType: string;
  }[]
): {
  readonly images?: {
    readonly count: number;
    readonly prepares: readonly {
      readonly path: string;
      readonly inputBytes: number;
      readonly outputBytes: number;
      readonly inputMediaType: string;
      readonly outputMediaType: string;
    }[];
  };
} {
  if (prepares.length === 0) {
    return {};
  }
  return {
    images: {
      count: prepares.length,
      prepares: prepares.map((prepare) => ({
        inputBytes: prepare.inputBytes,
        inputMediaType: prepare.inputMediaType,
        outputBytes: prepare.outputBytes,
        outputMediaType: prepare.outputMediaType,
        path: prepare.path,
      })),
    },
  };
}

export function summarizeImageOmits(
  omits: readonly {
    readonly limit: string;
    readonly mediaType: string;
    readonly filename?: string;
  }[]
): {
  readonly imageOmits?: {
    readonly count: number;
    readonly omits: readonly {
      readonly limit: string;
      readonly mediaType: string;
      readonly filename?: string;
    }[];
  };
} {
  if (omits.length === 0) {
    return {};
  }
  return {
    imageOmits: {
      count: omits.length,
      omits: omits.map((omit) => ({
        limit: omit.limit,
        mediaType: omit.mediaType,
        ...(omit.filename === undefined ? {} : { filename: omit.filename }),
      })),
    },
  };
}

/** Structured fields for a single image-prepare evlog event (no hand-rolled trees). */
export function imagePrepareLogEvent(diagnostics: {
  readonly path: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly inputMediaType: string;
  readonly outputMediaType: string;
  readonly maxImageBytes: number;
  readonly decodedWidth?: number;
  readonly decodedHeight?: number;
  readonly hasAlpha?: boolean;
  readonly message?: string;
}): Record<string, unknown> {
  return {
    message: diagnostics.message ?? "pss-runtime image-prepare",
    path: diagnostics.path,
    inputBytes: diagnostics.inputBytes,
    outputBytes: diagnostics.outputBytes,
    inputMediaType: diagnostics.inputMediaType,
    outputMediaType: diagnostics.outputMediaType,
    maxImageBytes: diagnostics.maxImageBytes,
    ...(diagnostics.decodedWidth === undefined
      ? {}
      : { decodedWidth: diagnostics.decodedWidth }),
    ...(diagnostics.decodedHeight === undefined
      ? {}
      : { decodedHeight: diagnostics.decodedHeight }),
    ...(diagnostics.hasAlpha === undefined
      ? {}
      : { hasAlpha: diagnostics.hasAlpha }),
  };
}
