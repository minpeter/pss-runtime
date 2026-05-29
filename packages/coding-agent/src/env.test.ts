import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOK_AT_MAX_IMAGE_BYTES,
  DEFAULT_LOOK_AT_MAX_OUTPUT_CHARS,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL_ID,
  readLookAtModelEnv,
  readOpenAICompatibleModelEnv,
  readTinyFishApiKeyPoolFromEnv,
} from "./env";

const aiApiKeyPattern = /AI_API_KEY/;
const aiBaseUrlPattern = /AI_BASE_URL/;
const tinyFishApiKeyPattern = /TINYFISH_API_KEY/;
const lookAtMaxOutputCharsPattern = /PSS_LOOK_AT_MAX_OUTPUT_CHARS/;
const lookAtMaxImageBytesPattern = /PSS_LOOK_AT_MAX_IMAGE_BYTES/;

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

  it("parses a TinyFish API key pool", () => {
    expect(
      readTinyFishApiKeyPoolFromEnv({
        runtimeEnv: {
          TINYFISH_API_KEY: " tf-token-1 ; ; tf-token-2 ",
        },
      })
    ).toEqual(["tf-token-1", "tf-token-2"]);
  });

  it("fails TinyFish env validation when no usable key exists", () => {
    expect(() =>
      readTinyFishApiKeyPoolFromEnv({
        runtimeEnv: {
          TINYFISH_API_KEY: " ; \t ; ",
        },
      })
    ).toThrow(tinyFishApiKeyPattern);
  });

  it("disables look_at config when the look_at model is absent", () => {
    expect(
      readLookAtModelEnv({
        runtimeEnv: {
          AI_API_KEY: "ai-token",
          AI_BASE_URL: "https://llm.test/v1",
        },
      })
    ).toEqual({
      enabled: false,
      model: undefined,
      baseUrl: undefined,
      apiKey: undefined,
      maxOutputChars: DEFAULT_LOOK_AT_MAX_OUTPUT_CHARS,
      maxImageBytes: DEFAULT_LOOK_AT_MAX_IMAGE_BYTES,
    });
  });

  it("validates explicit look_at model env", () => {
    expect(
      readLookAtModelEnv({
        runtimeEnv: {
          PSS_LOOK_AT_MODEL: " vision-model ",
          PSS_LOOK_AT_BASE_URL: " https://vision.test/v1 ",
          PSS_LOOK_AT_API_KEY: " vision-token ",
          PSS_LOOK_AT_MAX_OUTPUT_CHARS: " 4096 ",
          PSS_LOOK_AT_MAX_IMAGE_BYTES: " 2097152 ",
        },
      })
    ).toEqual({
      enabled: true,
      model: "vision-model",
      baseUrl: "https://vision.test/v1",
      apiKey: "vision-token",
      maxOutputChars: 4096,
      maxImageBytes: 2_097_152,
    });
  });

  it("inherits look_at base URL and API key from AI env", () => {
    expect(
      readLookAtModelEnv({
        runtimeEnv: {
          AI_API_KEY: " ai-token ",
          AI_BASE_URL: " https://llm.test/v1 ",
          PSS_LOOK_AT_MODEL: " vision-model ",
        },
      })
    ).toMatchObject({
      enabled: true,
      model: "vision-model",
      baseUrl: "https://llm.test/v1",
      apiKey: "ai-token",
    });
  });

  it("defaults look_at numeric limits", () => {
    expect(
      readLookAtModelEnv({
        runtimeEnv: {
          AI_API_KEY: "ai-token",
          AI_BASE_URL: "https://llm.test/v1",
          PSS_LOOK_AT_MODEL: "vision-model",
        },
      })
    ).toMatchObject({
      maxOutputChars: 2000,
      maxImageBytes: 10_485_760,
    });
  });

  it("fails look_at env validation when max output chars is invalid", () => {
    expect(() =>
      readLookAtModelEnv({
        runtimeEnv: {
          AI_API_KEY: "ai-token",
          AI_BASE_URL: "https://llm.test/v1",
          PSS_LOOK_AT_MODEL: "vision-model",
          PSS_LOOK_AT_MAX_OUTPUT_CHARS: "0",
        },
      })
    ).toThrow(lookAtMaxOutputCharsPattern);
  });

  it("fails look_at env validation when max image bytes is invalid", () => {
    expect(() =>
      readLookAtModelEnv({
        runtimeEnv: {
          AI_API_KEY: "ai-token",
          AI_BASE_URL: "https://llm.test/v1",
          PSS_LOOK_AT_MODEL: "vision-model",
          PSS_LOOK_AT_MAX_IMAGE_BYTES: "not-a-number",
        },
      })
    ).toThrow(lookAtMaxImageBytesPattern);
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
