import type { ModelMessage } from "ai";
import type { CompactionFixture, FixtureQuestion } from "./fixture";

const user = (content: string): ModelMessage => ({ content, role: "user" });
const assistant = (content: string): ModelMessage => ({
  content,
  role: "assistant",
});
const path = "src/Korean/設定/漢字.ts";
const identifier = "Author：＿更新・状態";
const clipping = "全角文字は80桁で切り詰めない";
const failedCommand = "Command failed: Permission denied (EACCES)";
const failedTests = "Failed: 2; 型エラー at 漢字.ts:42";
const retrySuccess = "Retry successful: cache has been reset";
const finalTests = "Passing: 18; 東京✓";

export function buildToolStateCjkFixture(seed: string): CompactionFixture {
  const messages: ModelMessage[] = [
    user(
      `Goal: implement ${identifier} in ${path}. Constraint: ${clipping}. seed=${seed}.`
    ),
    assistant(
      "I recorded the Korean, 日本語, and 中文 identifiers and constraints."
    ),
    user("Run the first command."),
    toolCall("cjk-command-1", "pnpm authority-check"),
    toolResult("cjk-command-1", failedCommand),
    assistant("The first command failed and remains as historical evidence."),
    user("Run the failing tests."),
    toolCall("cjk-test-1", "pnpm test 漢字"),
    toolResult("cjk-test-1", failedTests),
    assistant("I will preserve the failed test results."),
    user("Fix the permissions, then retry the command."),
    toolCall("cjk-command-2", "pnpm authority-check"),
    toolResult("cjk-command-2", retrySuccess),
    assistant("The retry command was successful."),
    user("Run the final test."),
    toolCall("cjk-test-2", "pnpm test 漢字"),
    toolResult("cjk-test-2", finalTests),
    assistant("The final test was successful."),
  ];
  const end = messages.length;
  messages.push(
    user("Preserve the CJK state and continue to the next turn."),
    assistant("I am ready to continue with the exact Unicode state.")
  );
  return {
    compactionEnds: [end],
    messages,
    questions: [
      question("exact-recall", identifier, "What is the correct identifier?"),
      question("file-state", path, "What is the current file path?"),
      question(
        "constraint-retention",
        clipping,
        "What are the precise truncation constraints?"
      ),
      question(
        "tool-history",
        failedCommand,
        "What was the result of the first command failure?"
      ),
      question(
        "tool-history",
        retrySuccess,
        "What is the result of the retry command?"
      ),
      question(
        "tool-history",
        failedTests,
        "What was the result of the failed test?"
      ),
      question("tool-history", finalTests, "What is the final test result?"),
    ],
    scenario: "tool-state-cjk",
  };
}

function question(
  category: FixtureQuestion["category"],
  answer: string,
  text: string
): FixtureQuestion {
  return { answer, category, question: text };
}

function toolCall(toolCallId: string, command: string): ModelMessage {
  return {
    content: [
      {
        input: { command },
        toolCallId,
        toolName: "run_command",
        type: "tool-call",
      },
    ],
    role: "assistant",
  };
}

function toolResult(toolCallId: string, value: string): ModelMessage {
  return {
    content: [
      {
        output: { type: "text", value },
        toolCallId,
        toolName: "run_command",
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}
