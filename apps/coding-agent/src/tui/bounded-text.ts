import { Text, visibleWidth } from "@earendil-works/pi-tui";

/** Keep source intact; only substitute glyphs that cannot fit a one-cell screen. */
export const renderBoundedText = (
  text: string,
  layout: {
    readonly width: number;
    readonly paddingX: number;
    readonly paddingY: number;
  },
  background?: (text: string) => string
): string[] => {
  const { width, paddingX, paddingY } = layout;
  const source =
    width === 1
      ? Array.from(new Intl.Segmenter().segment(text), ({ segment }) =>
          visibleWidth(segment) > 1 ? "?" : segment
        ).join("")
      : text;
  const padding = Math.min(paddingX, Math.max(0, Math.floor((width - 2) / 2)));
  return new Text(source, padding, paddingY, background).render(width);
};
