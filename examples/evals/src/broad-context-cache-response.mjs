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
  const responseModel = safeModelId(ownDataValue(body, "model"));
  const responseModelMatchesRequested =
    responseModel === null ? null : responseModel === requestedModel;
  if (!isPlainRecord(body)) {
    return invalidResponse(
      "invalid-response-shape",
      responseModel,
      responseModelMatchesRequested
    );
  }
  const responseError = ownDataProperty(body, "error");
  if (
    !responseError.valid ||
    (responseError.present && responseError.value != null)
  ) {
    return invalidResponse(
      "response-error-envelope",
      responseModel,
      responseModelMatchesRequested
    );
  }
  const choices = ownDataProperty(body, "choices");
  if (
    !(choices.valid && choices.present && isDenseSingleItemArray(choices.value))
  ) {
    return invalidResponse(
      "invalid-response-shape",
      responseModel,
      responseModelMatchesRequested
    );
  }
  const choice = ownDataValue(choices.value, "0");
  if (!isPlainRecord(choice)) {
    return invalidResponse(
      "invalid-response-shape",
      responseModel,
      responseModelMatchesRequested
    );
  }
  const finishReasonProperty = ownDataProperty(choice, "finish_reason");
  if (!(finishReasonProperty.valid && finishReasonProperty.present)) {
    return invalidResponse(
      "missing-finish-reason",
      responseModel,
      responseModelMatchesRequested
    );
  }
  const finishReason = safeFinishReason(finishReasonProperty.value);
  if (finishReason === null) {
    return invalidResponse(
      "unknown-finish-reason",
      responseModel,
      responseModelMatchesRequested
    );
  }
  if (finishReason !== "stop") {
    return invalidResponse(
      "non-stop-finish-reason",
      responseModel,
      responseModelMatchesRequested,
      finishReason
    );
  }
  const message = ownDataValue(choice, "message");
  const content = ownDataProperty(message, "content");
  const functionCall = ownDataProperty(message, "function_call");
  const toolCalls = ownDataProperty(message, "tool_calls");
  if (
    !(
      isPlainRecord(message) &&
      content.valid &&
      content.present &&
      typeof content.value === "string" &&
      functionCall.valid &&
      !(functionCall.present && functionCall.value != null) &&
      toolCalls.valid &&
      !(toolCalls.present && toolCalls.value != null)
    )
  ) {
    return invalidResponse(
      "invalid-response-shape",
      responseModel,
      responseModelMatchesRequested
    );
  }
  return {
    errorCode: null,
    finishReason,
    ok: true,
    responseModel,
    responseModelMatchesRequested,
    text: content.value,
  };
}

function invalidResponse(
  errorCode,
  responseModel,
  responseModelMatchesRequested,
  finishReason
) {
  return {
    errorCode,
    ...(finishReason === undefined ? {} : { finishReason }),
    ok: false,
    responseModel,
    responseModelMatchesRequested,
  };
}

function isDenseSingleItemArray(value) {
  if (!Array.isArray(value)) {
    return false;
  }
  const length = ownDataProperty(value, "length");
  if (!(length.valid && length.present && length.value === 1)) {
    return false;
  }
  const item = ownDataProperty(value, "0");
  return item.valid && item.present;
}

function isPlainRecord(value) {
  if (!(value !== null && typeof value === "object" && !Array.isArray(value))) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataProperty(value, key) {
  if (value === null || typeof value !== "object") {
    return { present: false, valid: true, value: undefined };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return { present: false, valid: true, value: undefined };
    }
    if (!Object.hasOwn(descriptor, "value")) {
      return { present: true, valid: false, value: undefined };
    }
    return { present: true, valid: true, value: descriptor.value };
  } catch {
    return { present: false, valid: false, value: undefined };
  }
}

function ownDataValue(value, key) {
  const property = ownDataProperty(value, key);
  return property.valid && property.present ? property.value : undefined;
}

function safeModelId(value) {
  return typeof value === "string" && SAFE_MODEL_ID_PATTERN.test(value)
    ? value
    : null;
}

function safeFinishReason(value) {
  return typeof value === "string" && FINISH_REASONS.has(value) ? value : null;
}
