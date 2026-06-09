import { parseHTML } from "linkedom";

export interface JSDOMOptions {
  readonly url?: string;
}

export class JSDOM {
  readonly window: Window & typeof globalThis;

  constructor(html: string, options?: JSDOMOptions) {
    const { window } = parseHTML(html);
    if (options?.url) {
      Object.defineProperty(window.document, "documentURI", {
        value: options.url,
        configurable: true,
      });
    }
    this.window = window as Window & typeof globalThis;
  }
}
