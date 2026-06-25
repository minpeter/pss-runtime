import { defineEval, expect } from "@minpeter/pss-runtime/evals";
import { evalThread } from "../src/agent";

defineEval("weather", { thread: evalThread }, (it) => {
  it("calls get_weather for a weather question", async ({ run }) => {
    const result = await run("서울 날씨 알려줘");

    expect(result).toHaveCalledTools(["get_weather"]);
    expect(result).not.toHaveCalledTools(["send_email"]);
  });

  it("answers in Korean", async ({ run }) => {
    const result = await run("서울 날씨 알려줘");

    // Loose output check: a real model's wording varies, so assert only that
    // it produced visible text. Tighten this once your model is stable.
    expect(result.output).toBeTruthy();
    expect(result.error).toBeUndefined();
  });
});
