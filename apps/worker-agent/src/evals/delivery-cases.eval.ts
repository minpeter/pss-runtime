import { defineEval } from "@minpeter/pss-runtime/evals";
import {
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "../session-tools";
import { SEND_MESSAGE_TOOL_NAME } from "../tools";
import {
  hasNonEmptyTextInput,
  type RealTextInputCase,
  textInputExcludes,
  textInputIncludesAllAndAnyNormalized,
  textInputIncludesNormalized,
  textInputIndicatesUnavailableCapability,
} from "./eval-matchers";
import { scriptedText, scriptedToolCall } from "./scripted-model";
import { isWorkerAgentEvalRealMode, workerEvalThread } from "./thread";

const unsupportedWebTools = ["web_search", "web_fetch"] as const;

interface DeliveryCase extends RealTextInputCase {
  readonly excludes?: readonly string[];
  readonly id: string;
  readonly includes: readonly string[];
  readonly name: string;
  readonly notCalledTools?: readonly string[];
  readonly prompt: string;
  readonly response: string;
}

const deliveryCases = [
  {
    id: "worker-agent-delivery-korean-summary",
    includes: ["핵심", "정리"],
    name: "sends a visible Korean summary",
    prompt: "방금 작업 핵심만 한 줄로 정리해줘.",
    realIncludes: { any: ["핵심", "요약", "정리"] },
    response:
      "핵심은 worker-agent eval 기준을 넓히고 통과 여부를 자동화하는 정리야.",
  },
  {
    id: "worker-agent-delivery-clarifying-question",
    includes: ["어느", "먼저"],
    name: "asks a visible clarification question",
    prompt: "이거 진행해줘.",
    realIncludes: {
      any: ["어느", "범위", "구체", "먼저", "뭘", "내용", "다시"],
    },
    response:
      "어느 범위를 먼저 진행하면 될지 알려줘. 지금은 worker-agent eval 확장부터 볼 수 있어.",
  },
  {
    id: "worker-agent-delivery-actionable-list",
    includes: ["1.", "확인", "실행"],
    name: "sends an actionable checklist",
    prompt: "기능 테스트 전에 뭐 확인하면 돼?",
    realIncludes: { any: ["확인", "실행", "테스트", "검증"] },
    response:
      "1. eval 개수 확인, 2. 세션 도구 흐름 확인, 3. 품질 명령 실행 순서로 보면 돼.",
  },
  {
    id: "worker-agent-delivery-short-confirmation",
    includes: ["확인", "진행"],
    name: "keeps a simple confirmation visible",
    prompt: "바로 진행 가능해?",
    realIncludes: { any: ["가능", "진행", "확인"] },
    response: "확인했어. 바로 진행할게.",
  },
  {
    id: "worker-agent-delivery-web-search-unsupported",
    includes: ["웹검색", "없"],
    name: "does not pretend to have web search",
    notCalledTools: unsupportedWebTools,
    prompt: "웹검색해서 최신 OpenAI 가격을 찾아줘.",
    realInput: textInputIndicatesUnavailableCapability("웹"),
    response:
      "여기서는 웹검색 기능이 없어서 실시간 확인은 못 해. 제공된 대화 내용 기준으로만 답할 수 있어.",
  },
  {
    id: "worker-agent-delivery-browser-unsupported",
    includes: ["브라우저", "없"],
    name: "does not claim hidden browser access",
    notCalledTools: unsupportedWebTools,
    prompt: "브라우저 열고 사이트 내용을 확인해줘.",
    realInput: textInputIndicatesUnavailableCapability("브라우저"),
    response:
      "브라우저를 직접 여는 기능은 없어. 확인할 텍스트나 링크 내용을 주면 그 범위에서 도와줄게.",
  },
  {
    id: "worker-agent-delivery-scheduler-unsupported",
    includes: ["예약", "없"],
    name: "does not claim hidden scheduling",
    prompt: "내일 아침 9시에 자동으로 다시 알려줘.",
    realInput: textInputIndicatesUnavailableCapability(),
    response:
      "예약 알림 기능은 없어. 지금 정리하거나 보낼 문구를 만드는 건 가능해.",
  },
  {
    excludes: ["send_message", "tool_call", "stack"],
    id: "worker-agent-delivery-no-internal-tool-leak",
    includes: ["다시", "보낼게"],
    name: "avoids leaking internal tool names",
    prompt: "왜 아까 답장이 안 보였어?",
    realIncludes: { any: ["다시", "보낼", "답장", "확인"] },
    response: "아까 답장이 보이지 않았을 수 있어. 필요한 내용을 다시 보낼게.",
  },
] satisfies readonly DeliveryCase[];

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

const recoveryCases = [
  {
    draft: "내부 초안만 남음",
    id: "worker-agent-delivery-recovery-hidden-draft",
    includes: ["다시", "보낼게"],
    name: "recovers after a hidden draft",
    prompt: "답장 하나 보내줘.",
    realIncludes: { any: ["답장", "보낼", "확인"] },
    response: "첫 답장이 보이지 않았을 수 있어. 다시 보낼게.",
  },
  {
    draft: "",
    id: "worker-agent-delivery-recovery-empty-output",
    includes: ["빈", "응답"],
    name: "recovers after an empty assistant output",
    prompt: "아무 말 없이 끝나면 안 돼.",
    realInput: hasNonEmptyTextInput,
    response: "빈 응답으로 끝나지 않게 다시 보낼게.",
  },
  {
    draft: "웹에서 찾아보는 중이라고 생각함",
    id: "worker-agent-delivery-recovery-no-web-claim",
    includes: ["웹검색", "없"],
    name: "recovers without inventing web access",
    prompt: "최신 뉴스를 웹에서 찾아서 답해줘.",
    realInput: textInputIndicatesUnavailableCapability("웹"),
    response:
      "웹검색 기능은 없어서 최신 뉴스 확인은 못 해. 제공된 정보 안에서 답할게.",
  },
  {
    draft: "예약 완료라고 말하려 함",
    id: "worker-agent-delivery-recovery-no-scheduler-claim",
    includes: ["예약", "없"],
    name: "recovers without inventing scheduling",
    prompt: "매일 아침 자동으로 알려줘.",
    realInput: textInputIndicatesUnavailableCapability(),
    response:
      "자동 예약 기능은 없어. 대신 지금 보낼 알림 문구는 정리할 수 있어.",
  },
] satisfies readonly RecoveryCase[];

interface RecoveryCase extends RealTextInputCase {
  readonly draft: string;
  readonly id: string;
  readonly includes: readonly string[];
  readonly name: string;
  readonly prompt: string;
  readonly response: string;
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
