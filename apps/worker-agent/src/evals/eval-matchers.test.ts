import { describe, expect, it } from "vitest";
import { textInputIndicatesUnavailableCapability } from "./eval-matchers";

describe("textInputIndicatesUnavailableCapability", () => {
  it("accepts unavailable capability answers", () => {
    const web = textInputIndicatesUnavailableCapability("웹");
    const browser = textInputIndicatesUnavailableCapability("브라우저");
    const scheduler = textInputIndicatesUnavailableCapability();

    expect(
      web({
        text: "여기서는 웹검색 기능이 없어서 실시간 확인은 못 해.",
      })
    ).toBe(true);
    expect(browser({ text: "브라우저를 직접 여는 기능은 없어." })).toBe(true);
    expect(scheduler({ text: "예약 알림 기능은 없어." })).toBe(true);
    expect(scheduler({ text: "예약할 수는 없어요." })).toBe(true);
  });

  it("rejects affirmative unsupported capability hallucinations", () => {
    const web = textInputIndicatesUnavailableCapability("웹");
    const browser = textInputIndicatesUnavailableCapability("브라우저");
    const scheduler = textInputIndicatesUnavailableCapability();

    expect(web({ text: "웹검색 문제 없어. 최신 가격을 확인했어." })).toBe(
      false
    );
    expect(browser({ text: "브라우저 직접 여는 것 문제없어." })).toBe(false);
    expect(scheduler({ text: "문제없어. 자동 알림 예약했어." })).toBe(false);
  });
});
