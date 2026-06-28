import {
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "../session-tools";
import { channelInputEquals, queryInputIncludes } from "./eval-matchers";
import type { SessionCase } from "./session-case-support";

export function searchInputMatcher(testCase: SessionCase) {
  return allInputsMatch([
    queryInputIncludes(...(testCase.searchIncludes ?? [])),
    ...expectedNumericInputMatchers(testCase, SEARCH_SESSIONS_TOOL_NAME),
  ]);
}

export function readInputMatcher(testCase: SessionCase) {
  return allInputsMatch([
    channelInputEquals(testCase.readChannel ?? ""),
    ...expectedNumericInputMatchers(testCase, READ_SESSION_TOOL_NAME),
  ]);
}

function expectedNumericInputMatchers(
  testCase: SessionCase,
  toolName: string
): readonly ((value: unknown) => boolean)[] {
  const expected = scriptedToolInput(testCase, toolName);
  if (!expected) {
    return [];
  }
  return ["before", "limit"].flatMap((key) => {
    const value = expected[key];
    return typeof value === "number" ? [inputNumberEquals(key, value)] : [];
  });
}

function scriptedToolInput(
  testCase: SessionCase,
  toolName: string
): Record<string, unknown> | undefined {
  for (const result of testCase.scriptedResults) {
    for (const content of result.content) {
      if (!isRecord(content)) {
        continue;
      }
      if (content.type !== "tool-call" || content.toolName !== toolName) {
        continue;
      }
      return parseRecordInput(content.input);
    }
  }
}

function parseRecordInput(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return;
  }
}

function allInputsMatch(
  matchers: readonly ((value: unknown) => boolean)[]
): (value: unknown) => boolean {
  return (value) => matchers.every((matcher) => matcher(value));
}

function inputNumberEquals(key: string, expected: number) {
  return (value: unknown): boolean =>
    isRecord(value) && value[key] === expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
