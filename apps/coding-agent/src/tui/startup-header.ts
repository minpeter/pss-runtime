import {
  type Component,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderBoundedText } from "./bounded-text";
import { ACCENT_LIME } from "./palette";

const ANSI_RESET = "\x1b[0m";
const ANSI_BG_WHITE = "\x1b[47m";
const ANSI_BLACK = "\x1b[30m";

export interface ColdStartupHeader {
  readonly kind: "startup-header";
  readonly subtitle: readonly string[];
  readonly title: readonly string[];
}

/** Keep metadata beside the wordmark while reflowing immutable startup data. */
export const renderStartupHeader = (
  content: ColdStartupHeader,
  width: number
): string[] => {
  if (width <= 3) {
    // Drop padding before wrapping: CJK needs two cells, and a one-cell
    // terminal uses the same lossless-source fallback as other bounded text.
    const lines = content.title.map(
      (title, index) => `${title}  ${content.subtitle[index] ?? ""}`
    );
    lines.push(...content.subtitle.slice(content.title.length));
    return renderBoundedText(lines.join("\n"), {
      width,
      paddingX: 0,
      paddingY: 0,
    });
  }
  const available = width - 2;
  return content.title
    .flatMap((title, index) => {
      const subtitle = content.subtitle[index] ?? "";
      const prefix = `${title}  `;
      const remaining = available - visibleWidth(prefix);
      if (remaining < 2) {
        return wrapTextWithAnsi(`${prefix}${subtitle}`, available);
      }
      const [first = "", ...rest] = wrapTextWithAnsi(subtitle, remaining);
      return [`${prefix}${first}`, ...rest];
    })
    .concat(
      content.subtitle
        .slice(content.title.length)
        .flatMap((line) => wrapTextWithAnsi(line, available))
    )
    .map((line) => (width > 2 ? ` ${line} ` : line));
};

/** Live pre-send header; only the model value is allowed to pulse. */
export class StartupHeaderView implements Component {
  readonly title: readonly string[];
  readonly subtitle: readonly string[];
  #model: string;
  #pulsing = false;

  constructor(
    title: readonly string[],
    subtitle: readonly string[],
    model: string
  ) {
    this.title = title;
    this.subtitle = subtitle;
    this.#model = model;
  }

  setModel(model: string, pulsing = false): void {
    this.#model = model;
    this.#pulsing = pulsing;
  }

  settle(): void {
    this.#pulsing = false;
  }

  captureCold(): ColdStartupHeader {
    // Pulse raw model text so inherited accent styling cannot leak into the
    // white/black feedback frame; restore the normal lime model afterward.
    const model = this.#pulsing
      ? `${ANSI_BG_WHITE}${ANSI_BLACK}${this.#model}${ANSI_RESET}`
      : `${ACCENT_LIME}${this.#model}${ANSI_RESET}`;
    return {
      kind: "startup-header",
      title: this.title,
      subtitle: [model, ...this.subtitle.slice(1)],
    };
  }

  render(width: number): string[] {
    return renderStartupHeader(this.captureCold(), width);
  }

  invalidate(): void {
    /* The mutable view is re-rendered explicitly after model changes. */
  }
}
