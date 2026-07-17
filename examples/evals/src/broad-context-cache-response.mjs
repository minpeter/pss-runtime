const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const FINISH_REASONS = new Set([
  "content-filter",
  "error",
  "length",
  "other",
  "stop",
  "tool-calls",
]);

/** Parse completion content independently from response-model attribution. */
export function parseCompletionResponse(body, requestedModel) {
  const responseModel = safeModelId(body?.model);
  const responseModelMatchesRequested =
    responseModel === null ? null : responseModel === requestedModel;
  if (!(Array.isArray(body?.choices) && body.choices.length === 1)) {
    return {
      errorCode: "invalid-response-shape",
      ok: false,
      responseModel,
      responseModelMatchesRequested,
    };
  }
  const choice = body.choices[0];
  const message =
    choice && typeof choice === "object" ? choice.message : undefined;
  if (
    !(
      message &&
      typeof message === "object" &&
      typeof message.content === "string"
    )
  ) {
    return {
      errorCode: "invalid-response-shape",
      ok: false,
      responseModel,
      responseModelMatchesRequested,
    };
  }
  return {
    errorCode: null,
    finishReason: safeFinishReason(choice.finish_reason),
    ok: true,
    responseModel,
    responseModelMatchesRequested,
    text: message.content,
  };
}

function safeModelId(value) {
  return typeof value === "string" && SAFE_MODEL_ID_PATTERN.test(value)
    ? value
    : null;
}

function safeFinishReason(value) {
  return typeof value === "string" && FINISH_REASONS.has(value) ? value : null;
}
