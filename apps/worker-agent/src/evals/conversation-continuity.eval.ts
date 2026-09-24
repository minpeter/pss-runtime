import {
  defineEval,
  type EvalRun,
  type ValueBuilder,
} from "@minpeter/pss-runtime/evals";

import {
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "../session/session-tools";
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
          "In this conversation, the codeword is marigold. Please only remember me in this conversation.",
        response:
          "Okay. I'll remember the codeword of this conversation as marigold.",
      },
      {
        expectedTokens: ["marigold"],
        prompt: "Just answer the codeword I just said.",
        response: "marigold",
      },
    ],
  },
  {
    id: "worker-agent-conversation-uses-latest-correction",
    name: "uses the latest correction from same-thread history",
    turns: [
      {
        prompt: "Please note that Project Zephyr release date is Friday.",
        response:
          "I made a note of the release date of Project Zephyr as Friday.",
      },
      {
        prompt:
          "I'll fix it. Project Zephyr release date is Thursday, not Friday.",
        response: "Correct. Project Zephyr release date is Thursday.",
      },
      {
        expectedTokens: ["Thursday"],
        prompt: "What was the final Project Zephyr release date?",
        response: "The final release date for Project Zephyr is Thursday.",
      },
    ],
  },
  {
    id: "worker-agent-conversation-resolves-pronoun-followup",
    name: "resolves a pronoun follow-up from prior same-thread content",
    turns: [
      {
        prompt:
          "Please remember that the pre-deployment checklist is in the order of backup, dry-run, and smoke-test.",
        response:
          "I'll remember the checklist order before deployment as backup, dry-run, and smoke-test.",
      },
      {
        expectedTokens: ["dry-run"],
        prompt: "Please answer the second item.",
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
