import type { LanguageModel } from "ai";
import type { AssertionHandle, EvalScope, JudgeCallOptions } from "./types";
import {
  closedQATask,
  factualityTask,
  runJudge,
  summarizesTask,
  type JudgeVerdict,
} from "./judge";

interface JudgeScopeOptions {
  readonly judgeModel?: () => LanguageModel;
  readonly recordPending: (
    label: string,
    severity: "gate" | "soft",
    resolve: () => Promise<JudgeVerdict>
  ) => AssertionHandle;
  readonly reply: () => string;
}

export function createJudgeScope({
  judgeModel,
  recordPending,
  reply,
}: JudgeScopeOptions): EvalScope["judge"] {
  const declare = (
    label: string,
    task: string,
    options: JudgeCallOptions | undefined
  ): AssertionHandle => {
    const model =
      options?.model === undefined ? judgeModel?.() : options.model;
    const value = options?.on === undefined ? reply() : options.on;
    if (model === undefined) {
      return recordPending(label, "gate", () =>
        Promise.resolve({
          pass: false,
          reason: "no judge model configured",
          score: 0,
        })
      );
    }
    const resolve = async () => {
      try {
        return await runJudge(model, task, value);
      } catch (e) {
        return {
          pass: false,
          reason:
            e instanceof Error ? `judge call failed: ${e.message}` : "judge call failed",
          score: 0,
        };
      }
    };
    return recordPending(label, "soft", resolve);
  };
  return {
    autoevals: {
      closedQA: (criterion, options) =>
        declare(`judge.closedQA(${criterion})`, closedQATask(criterion), options),
      factuality: (expected, options) =>
        declare("judge.factuality", factualityTask(expected), options),
      summarizes: (expected, options) =>
        declare("judge.summarizes", summarizesTask(expected), options),
    },
  };
}
