import { describe, expect, it } from "vitest";
import {
  textInputIndicatesDeniedAccess,
  textInputIndicatesUnavailableCapability,
  textInputIndicatesUnavailableCapabilityAbout,
} from "./eval-matchers";

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
    expect(scheduler({ text: "자동 알림을 직접 예약해두기는 어려워." })).toBe(
      true
    );
    expect(scheduler({ text: "내가 먼저 보내는 권한은 없어." })).toBe(true);
    expect(scheduler({ text: "예약 알림을 설정해두진 못합니다." })).toBe(true);
  });

  it("requires a topic when matching broad scheduling refusals", () => {
    const scheduler = textInputIndicatesUnavailableCapabilityAbout(
      "예약",
      "알림",
      "스케줄",
      "자동"
    );

    expect(scheduler({ text: "그건 조금 어려워." })).toBe(false);
    expect(scheduler({ text: "자동 알림 예약 기능은 없어." })).toBe(true);
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
    expect(scheduler({ text: "자동 알림을 캘린더에 등록 완료했어." })).toBe(
      false
    );
  });
});

describe("textInputIndicatesDeniedAccess", () => {
  it("rejects affirmative read claims", () => {
    const denied = textInputIndicatesDeniedAccess();

    expect(denied({ text: "그 세션은 읽을 수 있어요." })).toBe(false);
    expect(denied({ text: "그 세션은 권한이 없어 읽을 수 없어요." })).toBe(
      true
    );
  });
});
