import { Agent } from "@minpeter/pss-runtime";
import type { LanguageModel } from "ai";
import { createConversationTagPlugin } from "./conversation-plugin";
import {
  createDelegateToReaderTool,
  parentSessionNamespace,
} from "./delegate-tool";
import { createReadFileTool } from "./read-file-tool";

export function createReaderAgent(model: LanguageModel) {
  return new Agent({
    instructions:
      "fixtures/kb/ 문서를 read_file로 읽는다. 요청과 관련된 파일만 골라 읽고, 답변에 근거 파일 경로를 반드시 적어.",
    model,
    namespace: "reader",
    tools: {
      read_file: createReadFileTool(),
    },
  });
}

export function createCoordinatorAgent(
  model: LanguageModel,
  options: {
    readonly readerAgent: Agent;
    readonly sessionKey: string;
  }
) {
  const coordinatorNamespace = "coordinator";

  return new Agent({
    instructions:
      "대화를 조율한다. 지식베이스 조회는 reader에게 delegate_to_reader로 위임하고, reader가 인용한 파일 경로를 사용자에게 전달해.",
    model,
    namespace: coordinatorNamespace,
    plugins: [createConversationTagPlugin()],
    tools: {
      delegate_to_reader: createDelegateToReaderTool({
        description: "지식베이스 문서 읽기를 reader 에이전트에게 위임한다.",
        parentAgentNamespace: parentSessionNamespace(
          coordinatorNamespace,
          options.sessionKey
        ),
        parentSessionKey: options.sessionKey,
        readerAgent: options.readerAgent,
      }),
    },
  });
}
