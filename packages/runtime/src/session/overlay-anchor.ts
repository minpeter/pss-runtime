import type { ModelMessage } from "ai";

export interface CurrentTurnAnchor {
  readonly index: number;
  readonly matchOrdinal: number;
  readonly message: ModelMessage;
}

export function createCurrentTurnAnchor(
  priorHistory: readonly ModelMessage[],
  message: ModelMessage
): CurrentTurnAnchor {
  return {
    index: priorHistory.length,
    matchOrdinal: countMatchingMessages(priorHistory, message) + 1,
    message,
  };
}

export function resolveCurrentTurnIndex({
  canonicalHistory,
  currentTurn,
  history,
}: {
  readonly canonicalHistory?: readonly ModelMessage[];
  readonly currentTurn?: CurrentTurnAnchor;
  readonly history: readonly ModelMessage[];
}): number {
  if (!currentTurn) {
    return -1;
  }

  if (
    canonicalHistory !== undefined &&
    currentTurn.index < canonicalHistory.length
  ) {
    const canonicalRegionStart = findCanonicalHistoryRegionStart(
      history,
      canonicalHistory
    );
    if (canonicalRegionStart !== -1) {
      return canonicalRegionStart + currentTurn.index;
    }
  }

  const ordinalIndex = findCurrentTurnIndexByOrdinal(
    history,
    currentTurn.message,
    currentTurn.matchOrdinal
  );
  if (ordinalIndex !== -1) {
    return ordinalIndex;
  }

  const referenceIndex = history.lastIndexOf(currentTurn.message);
  if (referenceIndex !== -1) {
    return referenceIndex;
  }

  return findCurrentTurnIndexByValue(history, currentTurn.message);
}

function findCanonicalHistoryRegionStart(
  history: readonly ModelMessage[],
  canonicalHistory: readonly ModelMessage[]
): number {
  if (canonicalHistory.length === 0) {
    return 0;
  }

  const suffixStart = history.length - canonicalHistory.length;
  if (
    suffixStart >= 0 &&
    historyRegionMatches(history, canonicalHistory, suffixStart)
  ) {
    return suffixStart;
  }

  if (historyRegionMatches(history, canonicalHistory, 0)) {
    return 0;
  }

  for (
    let start = 1;
    start <= history.length - canonicalHistory.length;
    start += 1
  ) {
    if (historyRegionMatches(history, canonicalHistory, start)) {
      return start;
    }
  }

  return -1;
}

function historyRegionMatches(
  history: readonly ModelMessage[],
  canonicalHistory: readonly ModelMessage[],
  start: number
): boolean {
  return canonicalHistory.every((message, offset) =>
    modelMessageEquals(history[start + offset], message)
  );
}

function findCurrentTurnIndexByOrdinal(
  history: readonly ModelMessage[],
  currentTurnMessage: ModelMessage,
  currentTurnMatchOrdinal: number
): number {
  let seen = 0;
  for (let index = 0; index < history.length; index += 1) {
    if (modelMessageEquals(history[index], currentTurnMessage)) {
      seen += 1;
      if (seen === currentTurnMatchOrdinal) {
        return index;
      }
    }
  }

  return -1;
}

function findCurrentTurnIndexByValue(
  history: readonly ModelMessage[],
  currentTurnMessage: ModelMessage
): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (modelMessageEquals(history[index], currentTurnMessage)) {
      return index;
    }
  }

  return -1;
}

function countMatchingMessages(
  history: readonly ModelMessage[],
  currentTurnMessage: ModelMessage
): number {
  return history.filter((message) =>
    modelMessageEquals(message, currentTurnMessage)
  ).length;
}

function modelMessageEquals(
  left: ModelMessage | undefined,
  right: ModelMessage
): boolean {
  return left !== undefined && modelContentEquals(left, right);
}

function modelContentEquals(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]];
  const seen = new WeakMap<object, WeakSet<object>>();

  while (pending.length > 0) {
    const pair = pending.pop();
    if (!pair) {
      continue;
    }

    const [leftValue, rightValue] = pair;
    if (Object.is(leftValue, rightValue)) {
      continue;
    }

    if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
      if (!arraysEqual(leftValue, rightValue, seen, pending)) {
        return false;
      }
      continue;
    }

    if (isRecord(leftValue) || isRecord(rightValue)) {
      if (!recordsEqual(leftValue, rightValue, seen, pending)) {
        return false;
      }
      continue;
    }

    return false;
  }

  return true;
}

function arraysEqual(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, WeakSet<object>>,
  pending: [unknown, unknown][]
): boolean {
  if (!(Array.isArray(left) && Array.isArray(right))) {
    return false;
  }

  if (isSeenPair(left, right, seen)) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  const leftKeys = enumerableKeys(left);
  const rightKeys = enumerableKeys(right);
  if (!(leftKeys && rightKeys && keysEqual(leftKeys, rightKeys))) {
    return false;
  }

  rememberPair(left, right, seen);
  for (const key of leftKeys) {
    if (!enqueuePropertyComparison(left, right, key, pending)) {
      return false;
    }
  }

  return true;
}

function recordsEqual(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, WeakSet<object>>,
  pending: [unknown, unknown][]
): boolean {
  if (!(isRecord(left) && isRecord(right))) {
    return false;
  }

  if (isSeenPair(left, right, seen)) {
    return true;
  }

  const leftKeys = enumerableKeys(left);
  const rightKeys = enumerableKeys(right);
  if (!(leftKeys && rightKeys && keysEqual(leftKeys, rightKeys))) {
    return false;
  }

  rememberPair(left, right, seen);
  for (const key of leftKeys) {
    if (!enqueuePropertyComparison(left, right, key, pending)) {
      return false;
    }
  }

  return true;
}

function enumerableKeys(value: object): readonly string[] | undefined {
  try {
    return Object.keys(value);
  } catch {
    return;
  }
}

function keysEqual(
  leftKeys: readonly string[],
  rightKeys: readonly string[]
): boolean {
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  const rightKeySet = new Set(rightKeys);
  return leftKeys.every((key) => rightKeySet.has(key));
}

function enqueuePropertyComparison(
  left: object,
  right: object,
  key: string,
  pending: [unknown, unknown][]
): boolean {
  const leftDescriptor = propertyDescriptor(left, key);
  const rightDescriptor = propertyDescriptor(right, key);
  if (!(leftDescriptor?.enumerable && rightDescriptor?.enumerable)) {
    return false;
  }

  const leftHasValue = "value" in leftDescriptor;
  const rightHasValue = "value" in rightDescriptor;
  if (leftHasValue || rightHasValue) {
    if (!(leftHasValue && rightHasValue)) {
      return false;
    }

    pending.push([leftDescriptor.value, rightDescriptor.value]);
    return true;
  }

  pending.push([leftDescriptor.get, rightDescriptor.get]);
  pending.push([leftDescriptor.set, rightDescriptor.set]);
  return true;
}

function propertyDescriptor(
  value: object,
  key: string
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return;
  }
}

function isSeenPair(
  left: object,
  right: object,
  seen: WeakMap<object, WeakSet<object>>
): boolean {
  return seen.get(left)?.has(right) ?? false;
}

function rememberPair(
  left: object,
  right: object,
  seen: WeakMap<object, WeakSet<object>>
): void {
  const rights = seen.get(left);
  if (rights) {
    rights.add(right);
    return;
  }

  seen.set(left, new WeakSet([right]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
