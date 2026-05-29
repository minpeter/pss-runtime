import type { LanguageModel, ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createLookAtLlmMock,
  createOpenAICompatibleMock,
  dotenvConfigMock,
  providerMock,
} = vi.hoisted(() => ({
  createLookAtLlmMock: vi.fn(),
  createOpenAICompatibleMock: vi.fn(),
  dotenvConfigMock: vi.fn(),
  providerMock: vi.fn(),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

vi.mock("dotenv", () => ({
  config: dotenvConfigMock,
}));

vi.mock("@minpeter/pss-runtime", () => ({
  createLookAtLlm: createLookAtLlmMock,
}));

describe("createOpenAICompatibleModelFromEnv", () => {
  const aiEnvKeys = [
    "AI_API_KEY",
    "AI_BASE_URL",
    "AI_MODEL",
    "PSS_LOOK_AT_API_KEY",
    "PSS_LOOK_AT_BASE_URL",
    "PSS_LOOK_AT_MODEL",
  ] as const;
  const originalEnv = Object.fromEntries(
    aiEnvKeys.map((key) => [key, process.env[key]])
  ) as Record<(typeof aiEnvKeys)[number], string | undefined>;

  const restoreAiEnv = () => {
    for (const key of aiEnvKeys) {
      const value = originalEnv[key];

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  beforeEach(() => {
    vi.resetModules();
    restoreAiEnv();
    dotenvConfigMock.mockReset();
    createLookAtLlmMock.mockReset();
    createLookAtLlmMock.mockReturnValue({ runtime: "llm" });
    providerMock.mockReset();
    providerMock.mockReturnValue({
      provider: "test",
    } as unknown as LanguageModel);
    createOpenAICompatibleMock.mockReset();
    createOpenAICompatibleMock.mockReturnValue(providerMock);
  });

  afterEach(() => {
    restoreAiEnv();
  });

  it("builds a caller-owned LanguageModel from OpenAI-compatible env", async () => {
    const { createOpenAICompatibleModelFromEnv } = await import("./model");

    const model = createOpenAICompatibleModelFromEnv({
      runtimeEnv: {
        AI_API_KEY: " ai-token-1;ai-token-2 ",
        AI_BASE_URL: " https://llm.test/v1 ",
        AI_MODEL: " minimax/MiniMax-M2.7 ",
      },
    });

    expect(dotenvConfigMock).not.toHaveBeenCalled();
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "custom",
      apiKey: "ai-token-1;ai-token-2",
      baseURL: "https://llm.test/v1",
    });
    expect(providerMock).toHaveBeenCalledWith("minimax/MiniMax-M2.7");
    expect(model).toEqual({ provider: "test" });
  });

  it("loads dotenv only through the explicit dotenv helper", async () => {
    process.env.AI_API_KEY = " dotenv-token ";
    process.env.AI_BASE_URL = " https://dotenv.test/v1 ";
    process.env.AI_MODEL = " dotenv-model ";
    const { createCodingLanguageModel } = await import("./model");

    const model = createCodingLanguageModel({
      override: false,
      providerName: "dotenv-provider",
      quiet: false,
    });

    expect(dotenvConfigMock).toHaveBeenCalledWith({
      override: false,
      quiet: false,
    });
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "dotenv-provider",
      apiKey: "dotenv-token",
      baseURL: "https://dotenv.test/v1",
    });
    expect(providerMock).toHaveBeenCalledWith("dotenv-model");
    expect(model).toEqual({ provider: "test" });
  });

  it("does not create a look_at vision model when look_at env is disabled", async () => {
    const { createLookAtVisionModelFromEnv } = await import("./model");

    const model = createLookAtVisionModelFromEnv({
      runtimeEnv: {
        AI_API_KEY: "ai-token",
        AI_BASE_URL: "https://llm.test/v1",
      },
    });

    expect(dotenvConfigMock).not.toHaveBeenCalled();
    expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
    expect(model).toBeUndefined();
  });

  it("builds a look_at vision model from explicit look_at env", async () => {
    const { createLookAtVisionModelFromEnv } = await import("./model");

    const model = createLookAtVisionModelFromEnv({
      providerName: "vision-provider",
      runtimeEnv: {
        PSS_LOOK_AT_API_KEY: " vision-token ",
        PSS_LOOK_AT_BASE_URL: " https://vision.test/v1 ",
        PSS_LOOK_AT_MODEL: " vision-model ",
      },
    });

    expect(dotenvConfigMock).not.toHaveBeenCalled();
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "vision-provider",
      apiKey: "vision-token",
      baseURL: "https://vision.test/v1",
    });
    expect(providerMock).toHaveBeenCalledWith("vision-model");
    expect(model).toEqual({ provider: "test" });
  });

  it("inherits look_at provider credentials from AI env", async () => {
    const { createLookAtVisionModelFromEnv } = await import("./model");

    const model = createLookAtVisionModelFromEnv({
      runtimeEnv: {
        AI_API_KEY: " ai-token ",
        AI_BASE_URL: " https://llm.test/v1 ",
        PSS_LOOK_AT_MODEL: " vision-model ",
      },
    });

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "look_at",
      apiKey: "ai-token",
      baseURL: "https://llm.test/v1",
    });
    expect(providerMock).toHaveBeenCalledWith("vision-model");
    expect(model).toEqual({ provider: "test" });
  });

  it("builds a runtime look_at LLM with the main model and tools", async () => {
    const { createLookAtLlmFromEnv } = await import("./model");
    const mainModel = { provider: "main" } as unknown as LanguageModel;
    const webTools = {
      web_search: { description: "search" },
    } as unknown as ToolSet;

    const llm = createLookAtLlmFromEnv({
      instructions: "answer briefly",
      model: mainModel,
      runtimeEnv: {
        AI_API_KEY: " ai-token ",
        AI_BASE_URL: " https://llm.test/v1 ",
        PSS_LOOK_AT_MAX_IMAGE_BYTES: "1234",
        PSS_LOOK_AT_MAX_OUTPUT_CHARS: "567",
        PSS_LOOK_AT_MODEL: " vision-model ",
      },
      tools: webTools,
    });

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "look_at",
      apiKey: "ai-token",
      baseURL: "https://llm.test/v1",
    });
    expect(providerMock).toHaveBeenCalledWith("vision-model");
    expect(createLookAtLlmMock).toHaveBeenCalledWith({
      instructions: "answer briefly",
      maxImageBytes: 1234,
      maxOutputChars: 567,
      model: mainModel,
      toolChoice: undefined,
      tools: webTools,
      visionModel: { provider: "test" },
    });
    expect(llm).toEqual({ runtime: "llm" });
  });

  it("does not build a runtime look_at LLM when look_at env is disabled", async () => {
    const { createLookAtLlmFromEnv } = await import("./model");
    const mainModel = { provider: "main" } as unknown as LanguageModel;

    const llm = createLookAtLlmFromEnv({
      model: mainModel,
      runtimeEnv: {
        AI_API_KEY: "ai-token",
        AI_BASE_URL: "https://llm.test/v1",
      },
    });

    expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
    expect(createLookAtLlmMock).not.toHaveBeenCalled();
    expect(llm).toBeUndefined();
  });
});
