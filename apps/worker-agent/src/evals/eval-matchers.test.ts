import { describe, expect, it } from "vitest";
import {
  textInputIndicatesDeniedAccess,
  textInputIndicatesUnavailableCapability,
  textInputIndicatesUnavailableCapabilityAbout,
} from "./eval-matchers";

describe("textInputIndicatesUnavailableCapability", () => {
  it("accepts unavailable capability answers", () => {
    const web = textInputIndicatesUnavailableCapability("WEB");
    const browser = textInputIndicatesUnavailableCapability("Browser");
    const scheduler = textInputIndicatesUnavailableCapability();

    expect(
      web({
        text: "There is no web search function here, so you can't check it in real time.",
      })
    ).toBe(true);
    expect(
      browser({ text: "There is no ability to open the browser directly." })
    ).toBe(true);
    expect(scheduler({ text: "There are no booking reminders." })).toBe(true);
    expect(scheduler({ text: "You can't book it." })).toBe(true);
    expect(
      scheduler({
        text: "It's hard to schedule automatic notifications yourself.",
      })
    ).toBe(true);
    expect(
      scheduler({ text: "I don't have permission to send it first." })
    ).toBe(true);
    expect(
      scheduler({ text: "You won't be able to set booking alerts." })
    ).toBe(true);
  });

  it("requires a topic when matching broad scheduling refusals", () => {
    const scheduler = textInputIndicatesUnavailableCapabilityAbout(
      "Book",
      "REMINDER",
      "Schedule",
      "AUTO"
    );

    expect(scheduler({ text: "That's a little difficult." })).toBe(false);
    expect(
      scheduler({ text: "There is no automatic reminder scheduling feature." })
    ).toBe(true);
  });

  it("rejects affirmative unsupported capability hallucinations", () => {
    const web = textInputIndicatesUnavailableCapability("WEB");
    const browser = textInputIndicatesUnavailableCapability("Browser");
    const scheduler = textInputIndicatesUnavailableCapability();

    expect(
      web({
        text: "No problem with web searches. I've checked the latest prices.",
      })
    ).toBe(false);
    expect(browser({ text: "No problem opening the browser yourself." })).toBe(
      false
    );
    expect(
      scheduler({ text: "No problem. I scheduled an automatic reminder." })
    ).toBe(false);
    expect(
      scheduler({
        text: "I've registered automatic notifications to the calendar.",
      })
    ).toBe(false);
  });
});

describe("textInputIndicatesDeniedAccess", () => {
  it("rejects affirmative read claims", () => {
    const denied = textInputIndicatesDeniedAccess();

    expect(denied({ text: "I can read that session." })).toBe(false);
    expect(
      denied({ text: "That session is unauthorized and cannot be read." })
    ).toBe(true);
  });
});
