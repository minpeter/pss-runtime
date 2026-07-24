import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { createCodingAgentExtensionHost } from "./host";
import type { CodingAgentExtensionModule } from "./types";

describe("default-export coding agent extensions", () => {
  it("configures and activates a default-export factory", async () => {
    // Given
    const lifecycle: string[] = [];
    const extensionModule: CodingAgentExtensionModule = {
      default(pss) {
        pss.instructions.append("Factory instruction");
        pss.lifecycle.onActivate(({ mode }) => {
          lifecycle.push(`activate:${mode}`);
          return () => {
            lifecycle.push("dispose");
          };
        });
      },
      id: "factory-extension",
    };

    // When
    const host = await createCodingAgentExtensionHost([extensionModule]);
    const provider = createOpenAICompatible({
      apiKey: "test",
      baseURL: "https://example.com/v1",
      name: "test",
    });
    const agent = await createAgent({ model: provider("model") });
    await host.activate(agent, "exec");
    await host.dispose();
    await agent.dispose();

    // Then
    expect(host.instructionFragments).toEqual(["Factory instruction"]);
    expect(lifecycle).toEqual(["activate:exec", "dispose"]);
  });
});
