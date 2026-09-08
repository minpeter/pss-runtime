import {
  type Component,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
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
  const available = Math.max(1, width - 2);
  return content.title
    .flatMap((title, index) => {
      const subtitle = content.subtitle[index] ?? "";
      const prefix = `${title}  `;
      const remaining = available - visibleWidth(prefix);
      if (remaining < 1) {
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
    // Pulse raw model text so inherited dim styling cannot leak into the
    // white/black feedback frame; restore the normal dim model afterward.
    const model = this.#pulsing
      ? `${ANSI_BG_WHITE}${ANSI_BLACK}${this.#model}${ANSI_RESET}`
      : `${ANSI_DIM}${this.#model}${ANSI_RESET}`;
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
