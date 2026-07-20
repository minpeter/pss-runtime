import { defineEval } from "@minpeter/pss-runtime/evals";
import {
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "../session/session-tools";
import { SEND_MESSAGE_TOOL_NAME } from "../tools";
import { deliveryCases, recoveryCases } from "./delivery-case-fixtures";
import {
  hasNonEmptyTextInput,
  textInputExcludes,
  textInputIncludesAllAndAnyNormalized,
  textInputIncludesNormalized,
} from "./eval-matchers";
import { scriptedText, scriptedToolCall } from "./scripted-model";
import { isWorkerAgentEvalRealMode, workerEvalThread } from "./thread";

for (const testCase of deliveryCases) {
  defineEval(
    testCase.id,
    {
      tags: ["worker-agent", "delivery", "scripted"],
      thread: () => visibleDeliveryThread(testCase.response, testCase.id),
    },
    (it) => {
      it(testCase.name, async (t) => {
        await t.run(testCase.prompt);

        const realMode = isWorkerAgentEvalRealMode();
        const realIncludes = testCase.realIncludes ?? {
          all: testCase.includes,
        };
        const realInput =
          testCase.realInput ??
          textInputIncludesAllAndAnyNormalized(realIncludes);
        t.calledTool(SEND_MESSAGE_TOOL_NAME, {
          input: hasNonEmptyTextInput,
        });
        t.calledTool(SEND_MESSAGE_TOOL_NAME, {
          input: realMode
            ? realInput
            : textInputIncludesNormalized(...testCase.includes),
        });
        if (testCase.excludes) {
          t.calledTool(SEND_MESSAGE_TOOL_NAME, {
            input: textInputExcludes(...testCase.excludes),
          });
        }
        for (const toolName of testCase.notCalledTools ?? []) {
          t.notCalledTool(toolName);
        }
        if (!realMode) {
          t.notCalledTool(SEARCH_SESSIONS_TOOL_NAME);
          t.notCalledTool(READ_SESSION_TOOL_NAME);
          t.maxToolCalls(1);
        }
        t.completed();
        t.noFailedActions();
      });
    }
  );
}

for (const testCase of recoveryCases) {
  defineEval(
    testCase.id,
    {
      tags: ["worker-agent", "delivery", "recovery", "scripted"],
      thread: () =>
        workerEvalThread({
          scriptedResults: [
            scriptedText(testCase.draft),
            scriptedToolCall({
              input: { text: testCase.response },
              toolCallId: `${testCase.id}:send`,
              toolName: SEND_MESSAGE_TOOL_NAME,
            }),
            scriptedText(""),
          ],
        }),
    },
    (it) => {
      it(testCase.name, async (t) => {
        await t.run(testCase.prompt);

        const realMode = isWorkerAgentEvalRealMode();
        const realIncludes = testCase.realIncludes ?? {
          all: testCase.includes,
        };
        const realInput =
          testCase.realInput ??
          textInputIncludesAllAndAnyNormalized(realIncludes);
        t.calledTool(SEND_MESSAGE_TOOL_NAME, {
          input: realMode
            ? realInput
            : textInputIncludesNormalized(...testCase.includes),
        });
        t.completed();
        t.noFailedActions();
      });
    }
  );
}

function visibleDeliveryThread(response: string, id: string) {
  return workerEvalThread({
    scriptedResults: [
      scriptedToolCall({
        input: { text: response },
        toolCallId: `${id}:send`,
        toolName: SEND_MESSAGE_TOOL_NAME,
      }),
      scriptedText(""),
    ],
  });
}
