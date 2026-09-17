import { defineEval } from "@minpeter/pss-runtime/evals";
import { scriptedText, scriptedToolCall } from "../src/scripted-model";
import { evalThread } from "../src/thread";

const clearWeatherPattern = /Light/;

// Right tool: a weather question must call get_weather, never send_email.
defineEval(
  "weather",
  {
    thread: () =>
      evalThread([
        scriptedToolCall({
          input: { city: "Seoul" },
          toolCallId: "call_weather",
          toolName: "get_weather",
        }),
        scriptedText(
          "Seoul is currently sunny and the temperature is 21 degrees."
        ),
      ]),
  },
  (it) => {
    it("calls get_weather and answers about Seoul", async (t) => {
      await t.run("Let me know the weather in Seoul");

      t.calledTool("get_weather", {
        input: { city: "Seoul" },
        output: clearWeatherPattern,
      });
      t.notCalledTool("send_email");
      t.messageIncludes("Seoul");
      t.completed();
    });
  }
);
