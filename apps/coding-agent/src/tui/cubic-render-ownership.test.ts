import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type {
  CodingAgentExtensionFactory,
  ExtensionCapability,
} from "../extensions/index";
import { composeAssistantRenderers } from "./assistant-renderer";

const identity = (text: string) => text;
const markdownTheme: MarkdownTheme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
};

describe("delegated renderer ownership", () => {
  it("leaves cached delegates alive until their real Mermaid owner replaces or disposes them", async () => {
    // Vitest's source condition loads the public factory outside the declaration
    // graph; its renderer capability avoids coupling to Mermaid's internal files.
    const { createMermaidExtension } = await vi.importActual<{
      createMermaidExtension: CodingAgentExtensionFactory;
    }>("@minpeter/pss-extension-mermaid");
    const capabilities: ExtensionCapability[] = [];
    await createMermaidExtension({
      on: () => undefined,
      provide: (capability) => capabilities.push(capability),
      use: () => undefined,
    });
    const mermaid = capabilities.find(
      (capability) => capability.kind === "assistant-renderer"
    );
    if (mermaid?.kind !== "assistant-renderer") {
      throw new Error("Missing Mermaid renderer capability");
    }
    const disposed: string[] = [];
    const composed = composeAssistantRenderers([
      () => {
        let text = "";
        let closed = false;
        return {
          invalidate() {
            return;
          },
          setText(value) {
            text = value;
          },
          render() {
            if (closed) {
              throw new Error("Rendered disposed delegate");
            }
            return [text];
          },
          dispose() {
            if (closed) {
              throw new Error("Delegate disposed twice");
            }
            closed = true;
            disposed.push(text);
          },
        };
      },
      mermaid.renderer,
    ]);
    if (!composed) {
      throw new Error("Missing composed renderer");
    }
    const view = composed({
      markdownTheme,
      notify: () => undefined,
      notifyOnce: () => undefined,
      requestRender: () => undefined,
      signal: new AbortController().signal,
    });
    view.setText("FIRST");
    expect(view.render(24)).toEqual(["FIRST"]);
    view.setText("FIRST");
    view.invalidate();
    expect(view.render(48)).toEqual(["FIRST"]);
    expect(disposed).toEqual([]);
    view.setText("SECOND");
    expect(view.render(24)).toEqual(["SECOND"]);
    expect(disposed).toEqual(["FIRST"]);
    view.dispose?.();
    expect(disposed).toEqual(["FIRST", "SECOND"]);
  });
});
