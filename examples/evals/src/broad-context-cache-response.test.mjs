import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCompletionResponse } from "./broad-context-cache-response.mjs";

const requestedModel = "provider/requested-model";

describe("parseCompletionResponse", () => {
  it("accepts content and records an exact response model", () => {
    assert.deepEqual(
      parseCompletionResponse(completion(requestedModel), requestedModel),
      {
        errorCode: null,
        finishReason: "stop",
        ok: true,
        responseModel: requestedModel,
        responseModelMatchesRequested: true,
        text: '{"value":"ok"}',
      }
    );
  });

  it("keeps valid content while auditing a mismatched response model", () => {
    assert.deepEqual(
      parseCompletionResponse(
        completion("provider/aliased-model"),
        requestedModel
      ),
      {
        errorCode: null,
        finishReason: "stop",
        ok: true,
        responseModel: "provider/aliased-model",
        responseModelMatchesRequested: false,
        text: '{"value":"ok"}',
      }
    );
  });

  it("keeps valid content while auditing a missing response model", () => {
    const body = completion(undefined);
    assert.deepEqual(parseCompletionResponse(body, requestedModel), {
      errorCode: null,
      finishReason: "stop",
      ok: true,
      responseModel: null,
      responseModelMatchesRequested: null,
      text: '{"value":"ok"}',
    });
  });

  it("still rejects malformed completion content", () => {
    assert.deepEqual(
      parseCompletionResponse(
        { choices: [], model: requestedModel },
        requestedModel
      ),
      {
        errorCode: "invalid-response-shape",
        ok: false,
        responseModel: requestedModel,
        responseModelMatchesRequested: true,
      }
    );
  });

  it("rejects missing, unknown, and non-stop finish reasons", () => {
    const missing = completion(requestedModel);
    Reflect.deleteProperty(missing.choices[0], "finish_reason");
    assert.deepEqual(parseCompletionResponse(missing, requestedModel), {
      errorCode: "missing-finish-reason",
      ok: false,
      responseModel: requestedModel,
      responseModelMatchesRequested: true,
    });

    const unknown = completion(requestedModel);
    unknown.choices[0].finish_reason = "future-value";
    assert.deepEqual(parseCompletionResponse(unknown, requestedModel), {
      errorCode: "unknown-finish-reason",
      ok: false,
      responseModel: requestedModel,
      responseModelMatchesRequested: true,
    });

    const length = completion(requestedModel);
    length.choices[0].finish_reason = "length";
    assert.deepEqual(parseCompletionResponse(length, requestedModel), {
      errorCode: "non-stop-finish-reason",
      finishReason: "length",
      ok: false,
      responseModel: requestedModel,
      responseModelMatchesRequested: true,
    });
  });

  it("rejects tool-call responses and inherited completion fields", () => {
    const toolCall = completion(requestedModel);
    toolCall.choices[0].message.tool_calls = [];
    assert.equal(parseCompletionResponse(toolCall, requestedModel).ok, false);

    const inheritedFinishReason = completion(requestedModel);
    inheritedFinishReason.choices[0] = Object.create({
      finish_reason: "stop",
      message: { content: '{"value":"ok"}' },
    });
    assert.deepEqual(
      parseCompletionResponse(inheritedFinishReason, requestedModel),
      {
        errorCode: "invalid-response-shape",
        ok: false,
        responseModel: requestedModel,
        responseModelMatchesRequested: true,
      }
    );
  });

  it("rejects legacy function calls and accessors without invoking them", () => {
    const legacyCall = completion(requestedModel);
    legacyCall.choices[0].message.function_call = {
      arguments: "{}",
      name: "legacy_tool",
    };
    assert.equal(parseCompletionResponse(legacyCall, requestedModel).ok, false);

    let getterCalls = 0;
    const accessorCall = completion(requestedModel);
    Object.defineProperty(accessorCall.choices[0].message, "function_call", {
      get() {
        getterCalls += 1;
        return null;
      },
    });
    assert.equal(
      parseCompletionResponse(accessorCall, requestedModel).ok,
      false
    );
    assert.equal(getterCalls, 0);
  });

  it("does not invoke accessors while parsing an untrusted response", () => {
    let getterCalls = 0;
    const body = completion(requestedModel);
    Object.defineProperty(body.choices[0], "finish_reason", {
      get() {
        getterCalls += 1;
        return "stop";
      },
    });

    assert.deepEqual(parseCompletionResponse(body, requestedModel), {
      errorCode: "missing-finish-reason",
      ok: false,
      responseModel: requestedModel,
      responseModelMatchesRequested: true,
    });
    assert.equal(getterCalls, 0);
  });
});

function completion(model) {
  return {
    choices: [
      {
        finish_reason: "stop",
        message: { content: '{"value":"ok"}' },
      },
    ],
    model,
  };
}
