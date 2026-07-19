import {
  defineEval,
  type EvalRun,
  type ValueBuilder,
} from "@minpeter/pss-runtime/evals";

import {
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "../session-tools";
import { SEND_MESSAGE_TOOL_NAME } from "../tools";
import { hasNonEmptyTextInput } from "./eval-matchers";
import {
  type ScriptedResult,
  scriptedText,
  scriptedToolCall,
} from "./scripted-model";
import { workerEvalThread } from "./thread";

interface ContinuityTurn {
  readonly expectedTokens?: readonly string[];
  readonly prompt: string;
  readonly response: string;
}

interface ContinuityCase {
  readonly id: string;
  readonly name: string;
  readonly turns: readonly ContinuityTurn[];
}

const continuityCases = [
  {
    id: "worker-agent-conversation-remembers-codeword",
    name: "answers a follow-up from same-thread user history",
    turns: [
      {
        prompt:
          "이번 대화에서 코드워드는 marigold야. 이 대화 안에서만 기억해줘.",
        response: "알겠어. 이 대화의 코드워드는 marigold로 기억할게.",
      },
      {
        expectedTokens: ["marigold"],
        prompt: "방금 말한 코드워드만 답해줘.",
        response: "marigold",
      },
    ],
  },
  {
    id: "worker-agent-conversation-uses-latest-correction",
    name: "uses the latest correction from same-thread history",
    turns: [
      {
        prompt: "Project Zephyr 출시일은 Friday라고 일단 메모해줘.",
        response: "Project Zephyr 출시일을 Friday로 메모했어.",
      },
      {
        prompt: "정정할게. Project Zephyr 출시일은 Friday가 아니라 Thursday야.",
        response: "정정했어. Project Zephyr 출시일은 Thursday야.",
      },
      {
        expectedTokens: ["Thursday"],
        prompt: "최종 Project Zephyr 출시일이 뭐였지?",
        response: "Project Zephyr의 최종 출시일은 Thursday야.",
      },
    ],
  },
  {
    id: "worker-agent-conversation-resolves-pronoun-followup",
    name: "resolves a pronoun follow-up from prior same-thread content",
    turns: [
      {
        prompt:
          "배포 전 체크리스트는 backup, dry-run, smoke-test 순서라고 기억해줘.",
        response:
          "배포 전 체크리스트 순서는 backup, dry-run, smoke-test로 기억할게.",
      },
      {
        expectedTokens: ["dry-run"],
        prompt: "그중 두 번째 항목만 답해줘.",
        response: "dry-run",
      },
    ],
  },
] satisfies readonly ContinuityCase[];

for (const testCase of continuityCases) {
  defineEval(
    testCase.id,
    {
      tags: ["worker-agent", "conversation", "continuity", "scripted"],
      thread: () =>
        workerEvalThread({
          scriptedResults: scriptedResponses(testCase),
        }),
    },
    (it) => {
      it(testCase.name, async (t) => {
        let lastRun: EvalRun | undefined;
        for (const turn of testCase.turns) {
          lastRun = await t.run(turn.prompt);
          if (turn.expectedTokens) {
            t.check(lastRun, lastRunSendIncludes(turn.expectedTokens));
          }
        }

        if (lastRun) {
          t.check(lastRun, lastRunSendIncludes(finalExpectedTokens(testCase)));
        }
        t.calledTool(SEND_MESSAGE_TOOL_NAME, {
          input: hasNonEmptyTextInput,
          times: testCase.turns.length,
        });
        t.notCalledTool(SEARCH_SESSIONS_TOOL_NAME);
        t.notCalledTool(READ_SESSION_TOOL_NAME);
        t.completed();
        t.noFailedActions();
      });
    }
  );
}

function scriptedResponses(
  testCase: ContinuityCase
): readonly ScriptedResult[] {
  return testCase.turns.flatMap((turn, index) => [
    scriptedToolCall({
      input: { text: turn.response },
      toolCallId: `${testCase.id}:${index}:send`,
      toolName: SEND_MESSAGE_TOOL_NAME,
    }),
    scriptedText(""),
  ]);
}

function finalExpectedTokens(testCase: ContinuityCase): readonly string[] {
  return (
    [...testCase.turns].reverse().find((turn) => turn.expectedTokens)
      ?.expectedTokens ?? []
  );
}

function lastRunSendIncludes(tokens: readonly string[]): ValueBuilder<EvalRun> {
  return {
    defaultSeverity: "gate",
    label: `lastRunSendIncludes(${tokens.join(",")})`,
    score: (run) => {
      const text = lastSendMessageText(run);
      const pass =
        text !== undefined &&
        normalizeTokens(tokens).every((token) =>
          normalizeComparable(text).includes(token)
        );
      return {
        detail: pass
          ? undefined
          : `last send_message text was ${JSON.stringify(text ?? "")}`,
        pass,
        score: pass ? 1 : 0,
      };
    },
  };
}

function lastSendMessageText(run: EvalRun): string | undefined {
  return [...run.toolCalls]
    .reverse()
    .map((call) =>
      call.toolName === SEND_MESSAGE_TOOL_NAME
        ? readStringProperty(call.input, "text")
        : undefined
    )
    .find((text) => text !== undefined);
}

function normalizeTokens(tokens: readonly string[]): readonly string[] {
  return tokens.map(normalizeComparable);
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replaceAll(/\s+/g, "");
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return;
  }
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

import { isRecord } from "./eval-matchers";
