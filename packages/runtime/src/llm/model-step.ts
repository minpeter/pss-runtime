import { generateText } from "ai";
import { hydrateRuntimeAttachments } from "../thread/input/attachments";
import { enforceContextGate } from "./context-gate";
import { ModelToolSelectionError } from "./model-step-error";
import { resolveModelStepOptions } from "./model-step-preparation";
import { promptForModel, snapshotModelHistory } from "./model-prompt";
import type {
  ModelStepOptions,
  ModelStepOutput,
  ModelStepResult,
} from "./model-step-types";
import {
  configuredModelId,
  configuredProvider,
  firstSafeTelemetryIdentifier,
  modelUsageEvent,
} from "./model-usage";
import { assertNoUnsupportedToolApproval } from "./tool-approval";
import { rewriteMessageToolCallIds } from "./tool-call-ids";
import { normalizeToolCallIds } from "./tool-execution-wrapper";

export async function generateModelStep(
  options: ModelStepOptions
): Promise<ModelStepOutput> {
  return (await generateModelStepResult(options)).messages;
}

export async function generateModelStepResult({
  alwaysActiveTools,
  attachmentStore,
  contextGate,
  diagnostics,
  history,
  model,
  instructions,
  prepareModelStep,
  runtimeStepIndex = 0,
  signal,
  threadKey,
  toolChoice,
  toolOrder,
  toolExecution,
  tools,
}: ModelStepOptions): Promise<ModelStepResult> {
  if (prepareModelStep && threadKey === undefined) {
    throw new ModelToolSelectionError(
      "prepareModelStep requires a runtime threadKey."
    );
  }
  const attemptId = crypto.randomUUID();
  const historySnapshot = snapshotModelHistory(history);
  const toolCallIds = new Map<string, string>();
  const prepared = await resolveModelStepOptions({
    alwaysActiveTools,
    attemptId,
    diagnostics,
    history: historySnapshot,
    model,
    prepareModelStep,
    runtimeStepIndex,
    signal,
    threadKey,
    toolChoice,
    toolOrder,
    tools,
  });
  const prompt = promptForModel({ history: historySnapshot, instructions });
  const messages = await hydrateRuntimeAttachments(
    prompt.messages,
    attachmentStore
  );
  enforceContextGate({
    contextGate,
    instructions: prompt.instructions,
    messages,
  });
  assertNoUnsupportedToolApproval(prepared.tools);
  const modelRequest = generateText({
    activeTools: prepared.activeTools,
    abortSignal: signal,
    instructions: prompt.instructions,
    messages,
    model: prepared.model,
    toolChoice: prepared.toolChoice,
    toolOrder: prepared.toolOrder,
    tools: normalizeToolCallIds(prepared.tools, toolCallIds, toolExecution),
  });
  prepared.startToolCacheFingerprintReport?.();
  const { finalStep, finishReason, response, responseMessages, usage } =
    await modelRequest;

  return {
    messages: responseMessages.map((message) =>
      rewriteMessageToolCallIds(message, toolCallIds)
    ),
    usage: modelUsageEvent({
      attemptId,
      durationMs: finalStep?.performance.responseTimeMs,
      finishReason,
      modelId: firstSafeTelemetryIdentifier(
        response?.modelId ??
          finalStep?.model.modelId ??
          configuredModelId(prepared.model),
        finalStep?.model.modelId,
        configuredModelId(prepared.model)
      ),
      provider: firstSafeTelemetryIdentifier(
        finalStep?.model.provider,
        configuredProvider(prepared.model)
      ),
      usage,
    }),
  };
}
