export interface RealTextInputCase {
  readonly realIncludes?: {
    readonly all?: readonly string[];
    readonly any?: readonly string[];
  };
  readonly realInput?: (value: unknown) => boolean;
}

export function hasNonEmptyTextInput(value: unknown): boolean {
  const text = readStringProperty(value, "text");
  return text !== undefined && text.trim().length > 0;
}

export function textInputIncludes(...tokens: readonly string[]) {
  return (value: unknown): boolean => {
    const text = readStringProperty(value, "text");
    return text !== undefined && includesAll(text, tokens);
  };
}

export function textInputIncludesNormalized(...tokens: readonly string[]) {
  return (value: unknown): boolean => {
    const text = readStringProperty(value, "text");
    return (
      text !== undefined &&
      includesAll(normalizeComparable(text), normalizeTokens(tokens))
    );
  };
}

export function textInputIncludesAny(...tokens: readonly string[]) {
  return (value: unknown): boolean => {
    const text = readStringProperty(value, "text");
    return text !== undefined && tokens.some((token) => text.includes(token));
  };
}

export function textInputIncludesAnyNormalized(...tokens: readonly string[]) {
  return (value: unknown): boolean => {
    const text = readStringProperty(value, "text");
    return (
      text !== undefined &&
      normalizeTokens(tokens).some((token) =>
        normalizeComparable(text).includes(token)
      )
    );
  };
}

export function textInputIncludesAllAndAnyNormalized({
  all = [],
  any = [],
}: {
  readonly all?: readonly string[];
  readonly any?: readonly string[];
}) {
  return (value: unknown): boolean => {
    const text = readStringProperty(value, "text");
    if (text === undefined) {
      return false;
    }
    const normalizedText = normalizeComparable(text);
    const required = normalizeTokens(all);
    const alternatives = normalizeTokens(any);
    return (
      required.every((token) => normalizedText.includes(token)) &&
      (alternatives.length === 0 ||
        alternatives.some((token) => normalizedText.includes(token)))
    );
  };
}

export function textInputIndicatesUnavailableCapability(
  ...requiredTokens: readonly string[]
) {
  return (value: unknown): boolean => {
    const text = readStringProperty(value, "text");
    if (text === undefined) {
      return false;
    }
    const normalizedText = normalizeComparable(text);
    return (
      normalizeTokens(requiredTokens).every((token) =>
        normalizedText.includes(token)
      ) && includesUnavailableCapabilitySignal(normalizedText)
    );
  };
}

export function textInputIndicatesUnavailableCapabilityAbout(
  ...topicTokens: readonly string[]
) {
  return (value: unknown): boolean => {
    const text = readStringProperty(value, "text");
    if (text === undefined) {
      return false;
    }
    const normalizedText = normalizeComparable(text);
    return (
      normalizeTokens(topicTokens).some((token) =>
        normalizedText.includes(token)
      ) && includesUnavailableCapabilitySignal(normalizedText)
    );
  };
}

export function textInputIndicatesDeniedAccess() {
  return (value: unknown): boolean => {
    const text = readStringProperty(value, "text");
    return (
      text !== undefined &&
      includesDeniedAccessSignal(normalizeComparable(text))
    );
  };
}

export function textInputExcludes(...tokens: readonly string[]) {
  return (value: unknown): boolean => {
    const text = readStringProperty(value, "text");
    return text !== undefined && tokens.every((token) => !text.includes(token));
  };
}

export function queryInputIncludes(...tokens: readonly string[]) {
  return (value: unknown): boolean => {
    const query = readStringProperty(value, "query");
    return (
      query !== undefined && includesAll(query.toLowerCase(), lower(tokens))
    );
  };
}

export function channelInputEquals(channel: string) {
  return (value: unknown): boolean =>
    readStringProperty(value, "channel") === channel;
}

export function foundOutputEquals(found: boolean) {
  return (value: unknown): boolean => {
    const output = unwrapToolOutput(value);
    if (!isRecord(output)) {
      return false;
    }
    return output.found === found;
  };
}

export function sessionsOutputCount(count: number) {
  return (value: unknown): boolean => {
    const output = unwrapToolOutput(value);
    if (!(isRecord(output) && Array.isArray(output.sessions))) {
      return false;
    }
    return output.sessions.length === count;
  };
}

function includesAll(text: string, tokens: readonly string[]): boolean {
  return tokens.every((token) => text.includes(token));
}

function includesUnavailableCapabilitySignal(text: string): boolean {
  const signals = [
    "기능이없",
    "기능은없",
    "기능없",
    "권한은없",
    "권한이없",
    "권한없",
    "불가",
    "불가능",
    "지원하지",
    "제공하지",
    "제공되지",
    "어려워",
    "어렵",
    "안돼",
    "안되",
    "못해",
    "못하",
    "못합",
    "못합니다",
    "못써",
    "못쓰",
    "할수없",
    "수없",
    "수는없",
  ] as const;
  return signals.some((signal) => text.includes(signal));
}

function includesDeniedAccessSignal(text: string): boolean {
  const signals = [
    "권한없",
    "권한이없",
    "권한은없",
    "접근할수없",
    "읽을수없",
    "읽을수는없",
    "읽지못",
    "확인할수없",
    "확인되지",
    "찾을수없",
    "불러올수없",
    "기록이없",
    "기록은없",
    "세션이없",
    "세션은없",
  ] as const;
  return signals.some((signal) => text.includes(signal));
}

function lower(tokens: readonly string[]): readonly string[] {
  return tokens.map((token) => token.toLowerCase());
}

function normalizeTokens(tokens: readonly string[]): readonly string[] {
  return tokens.map(normalizeComparable);
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replaceAll(/\s+/g, "");
}

function unwrapToolOutput(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return value.type === "json" && "value" in value ? value.value : value;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return;
  }
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
