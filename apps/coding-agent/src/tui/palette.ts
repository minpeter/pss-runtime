/**
 * Eva Unit-01 palette for the pss TUI: the one place foreground accents are
 * chosen, so surfaces share roles instead of raw SGR codes.
 *
 * - Electric lime carries live emphasis: spinner, running status, headings,
 *   inline/block code, tool arguments, resume/continuation labels, grep paths,
 *   the settled startup model, and "current" markers.
 * - Indigo armor carries the wordmark and structure: rules, quote and
 *   code-block borders, list bullets, links.
 * - Burnt orange marks the selected row in pickers.
 * - Aubergine is the plate behind the user's own messages.
 * - Red/yellow are reserved for errors/warnings; muted gray for secondary text.
 *
 * Background semantics elsewhere are unchanged: tool bodies stay on `\x1b[100m`
 * (see `renderers/utils` RESTORE_ON_GRAY_BG), tool errors on dark red, resume
 * cards on palette 235, and feedback pulses on white/black.
 *
 * 256-color indexes match the existing SGR style in this tree (208, 245, ...).
 * Contrast on the #0d1117 QA background: lime 14.7:1, indigo 4.6:1,
 * orange 7.9:1; bright white on the aubergine plate 11.4:1.
 */

/** Electric lime (xterm 118, #87ff00): primary emphasis. */
export const ACCENT_LIME = "\x1b[38;5;118m";
/** Indigo armor (xterm 99, #875fff): wordmark and structural accents. */
export const ACCENT_INDIGO = "\x1b[38;5;99m";
/** Burnt orange (xterm 208, #ff8700): picker selection. */
export const ACCENT_ORANGE = "\x1b[38;5;208m";
/** Aubergine plate (xterm 54, #5f0087) behind user messages. */
export const BG_USER_PLATE = "\x1b[48;5;54m";
/** Explicit bright text for use on the aubergine plate and card titles. */
export const TEXT_BRIGHT = "\x1b[97m";
/** Muted secondary text (xterm 245, #8a8a8a). */
export const TEXT_MUTED = "\x1b[38;5;245m";
export const STATUS_WARNING = "\x1b[33m";
export const STATUS_ERROR = "\x1b[31m";
