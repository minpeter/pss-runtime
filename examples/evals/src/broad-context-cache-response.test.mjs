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
