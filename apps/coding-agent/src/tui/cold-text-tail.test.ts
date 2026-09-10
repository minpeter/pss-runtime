import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { renderColdContent, selectColdTail } from "./cold-content";

it("retains the bounded renderer's whole tail when captured at three columns", () => {
  const content = {
    kind: "text" as const,
    text: "ABCDEFGHIJKL",
    paddingX: 1,
    paddingY: 0,
  };
  const selected = selectColdTail(content, 3, 2);
  expect(renderColdContent(selected, 3)).toEqual(
    renderColdContent(content, 3).slice(-2)
  );
  expect(
    renderColdContent(selected, 80).map(stripTerminalSequences).join("").trim()
  ).toBe("GHIJKL");
});
