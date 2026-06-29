import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL_ID,
  readOpenAICompatibleModelEnv,
} from "./env";

const aiApiKeyPattern = /AI_API_KEY/;
const aiBaseUrlPattern = /AI_BASE_URL/;

describe("coding-agent env validation", () => {
  it("validates and normalizes OpenAI-compatible model env", () => {
    expect(
      readOpenAICompatibleModelEnv({
        runtimeEnv: {
          AI_API_KEY: " ai-token ",
          AI_BASE_URL: "",
          AI_MODEL: "",
        },
      })
    ).toMatchObject({
      AI_API_KEY: "ai-token",
      AI_BASE_URL: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
      AI_MODEL: DEFAULT_OPENAI_COMPATIBLE_MODEL_ID,
    });
  });

  it("fails model env validation when the API key is missing", () => {
    expect(() =>
      readOpenAICompatibleModelEnv({
        runtimeEnv: {},
      })
    ).toThrow(aiApiKeyPattern);
  });

  it("fails model env validation when the base URL is invalid", () => {
    expect(() =>
      readOpenAICompatibleModelEnv({
        runtimeEnv: {
          AI_API_KEY: "ai-token",
          AI_BASE_URL: "not-a-url",
        },
      })
    ).toThrow(aiBaseUrlPattern);
  });

  it("does not mutate the caller-provided runtime env object", () => {
    const runtimeEnv = {
      AI_API_KEY: " ai-token ",
      AI_BASE_URL: "",
      AI_MODEL: "",
    };

    readOpenAICompatibleModelEnv({ runtimeEnv });

    expect(runtimeEnv).toEqual({
      AI_API_KEY: " ai-token ",
      AI_BASE_URL: "",
      AI_MODEL: "",
    });
  });
});
