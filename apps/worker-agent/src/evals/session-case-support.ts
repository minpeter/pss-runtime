import {
  defineEval,
  type EvalScope,
  type ToolCallMatcherOptions,
} from "@minpeter/pss-runtime/evals";
import {
  LIST_SESSIONS_TOOL_NAME,
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
  type WorkerAgentSessionToolOptions,
} from "../session/session-tools";
import { SEND_MESSAGE_TOOL_NAME } from "../tools";
import {
  foundOutputEquals,
  hasNonEmptyTextInput,
  sessionsOutputCount,
  textInputIncludesAllAndAnyNormalized,
  textInputIncludesNormalized,
} from "./eval-matchers";
import type { ScriptedResult } from "./scripted-model";
import {
  readInputMatcher,
  searchInputMatcher,
} from "./session-case-input-matchers";
import { projectZephyrRecord } from "./session-fixture-records";
import { createEvalSessionTools } from "./session-fixtures";
import { isWorkerAgentEvalRealMode, workerEvalThread } from "./thread";

export interface SessionCase {
  readonly expectList?: boolean;
  readonly id: string;
  readonly maxToolCalls?: number;
  readonly name: string;
  readonly notCalledTools?: readonly string[];
  readonly prompt: string;
  readonly readChannel?: string;
  readonly readFound?: boolean;
  readonly realResponseIncludes?: readonly string[];
  readonly realResponseIncludesAny?: readonly string[];
  readonly responseIncludes: readonly string[];
  readonly scriptedResults: readonly ScriptedResult[];
  readonly searchIncludes?: readonly string[];
  readonly searchResultCount?: number;
  readonly sessionTools?: WorkerAgentSessionToolOptions;
  readonly toolOrder: readonly string[];
}

export const noSessionTools = createEvalSessionTools({ records: [] });
export const zephyrMissingTranscriptTools = createEvalSessionTools({
  missingTranscriptChannels: ["telegram:zephyr"],
  records: [projectZephyrRecord],
});

export function defineSessionCases(cases: readonly SessionCase[]): void {
  for (const testCase of cases) {
    defineEval(
      testCase.id,
      {
        tags: ["worker-agent", "sessions", "scripted"],
        thread: () =>
          workerEvalThread({
            scriptedResults: testCase.scriptedResults,
            sessionTools: testCase.sessionTools ?? createEvalSessionTools(),
          }),
      },
      (it) => {
        it(testCase.name, async (t) => {
          await t.run(testCase.prompt);

          const realMode = isWorkerAgentEvalRealMode();
          assertSessionCase(t, testCase, realMode);
        });
      }
    );
  }
}

function assertSessionCase(
  t: EvalScope,
  testCase: SessionCase,
  realMode: boolean
): void {
  assertScriptedOrder(t, testCase, realMode);
  assertListLookup(t, testCase, realMode);
  assertSearchLookup(t, testCase);
  assertReadLookup(t, testCase);
  assertVisibleSessionAnswer(t, testCase, realMode);
  assertForbiddenTools(t, testCase);
  assertScriptedToolBudget(t, testCase, realMode);
  t.completed();
  t.noFailedActions();
}

function assertScriptedOrder(
  t: EvalScope,
  testCase: SessionCase,
  realMode: boolean
): void {
  if (!realMode) {
    t.toolOrder(testCase.toolOrder);
  }
}

function assertListLookup(
  t: EvalScope,
  testCase: SessionCase,
  realMode: boolean
): void {
  if (testCase.expectList && shouldRequireListLookup(testCase, realMode)) {
    t.calledTool(LIST_SESSIONS_TOOL_NAME);
  }
}

function shouldRequireListLookup(
  testCase: SessionCase,
  realMode: boolean
): boolean {
  return !(realMode && testCase.readChannel);
}

function assertSearchLookup(t: EvalScope, testCase: SessionCase): void {
  if (testCase.searchIncludes) {
    t.calledTool(SEARCH_SESSIONS_TOOL_NAME, searchToolOptions(testCase));
  }
}

function searchToolOptions(testCase: SessionCase): ToolCallMatcherOptions {
  const outputOptions = searchOutputOptions(testCase);
  return {
    ...outputOptions,
    input: searchInputMatcher(testCase),
  };
}

function searchOutputOptions(testCase: SessionCase): ToolCallMatcherOptions {
  if (testCase.searchResultCount === undefined) {
    return {};
  }
  return { output: sessionsOutputCount(testCase.searchResultCount) };
}

function assertReadLookup(t: EvalScope, testCase: SessionCase): void {
  if (testCase.readChannel) {
    t.calledTool(READ_SESSION_TOOL_NAME, {
      input: readInputMatcher(testCase),
      output: foundOutputEquals(testCase.readFound ?? true),
    });
  }
}

function assertVisibleSessionAnswer(
  t: EvalScope,
  testCase: SessionCase,
  realMode: boolean
): void {
  const responseIncludes = responseTokens(testCase, realMode);
  t.calledTool(SEND_MESSAGE_TOOL_NAME, {
    input: responseMatcher(testCase, realMode, responseIncludes),
  });
}

function responseTokens(
  testCase: SessionCase,
  realMode: boolean
): readonly string[] {
  if (realMode && testCase.realResponseIncludes) {
    return testCase.realResponseIncludes;
  }
  if (realMode && testCase.realResponseIncludesAny) {
    return [];
  }
  return testCase.responseIncludes;
}

function responseMatcher(
  testCase: SessionCase,
  realMode: boolean,
  responseIncludes: readonly string[]
) {
  if (realMode && testCase.realResponseIncludesAny) {
    return textInputIncludesAllAndAnyNormalized({
      all: responseIncludes,
      any: testCase.realResponseIncludesAny,
    });
  }
  if (responseIncludes.length === 0) {
    return hasNonEmptyTextInput;
  }
  return textInputIncludesNormalized(...responseIncludes);
}

function assertForbiddenTools(t: EvalScope, testCase: SessionCase): void {
  for (const toolName of testCase.notCalledTools ?? []) {
    t.notCalledTool(toolName);
  }
}

function assertScriptedToolBudget(
  t: EvalScope,
  testCase: SessionCase,
  realMode: boolean
): void {
  if (!realMode) {
    t.maxToolCalls(testCase.maxToolCalls ?? testCase.toolOrder.length);
  }
}
