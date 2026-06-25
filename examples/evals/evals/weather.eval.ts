import { defineEval, expect } from "@minpeter/pss-runtime/evals";
import { scriptedText, scriptedToolCall } from "../src/scripted-model";
import { evalThread } from "../src/thread";

// Right tool: a weather question must call get_weather, never send_email.
defineEval(
  "weather",
  {
    thread: () =>
      evalThread([
        scriptedToolCall({
          input: { city: "서울" },
          toolCallId: "call_weather",
          toolName: "get_weather",
        }),
        scriptedText("서울은 현재 맑고 기온은 21도입니다."),
      ]),
  },
  (it) => {
    it("calls get_weather and answers about Seoul", async ({ run }) => {
      const result = await run("서울 날씨 알려줘");

      expect(result).toHaveCalledTools(["get_weather"]);
      expect(result).not.toHaveCalledTools(["send_email"]);
      expect(result.output).toContain("서울");
    });
  }
);
