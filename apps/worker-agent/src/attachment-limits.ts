/** Shared pre-DO image hop budgets (Telegram collect + DO parse). */
export const AGENT_MAX_TURN_IMAGES = 10;
export const AGENT_MAX_RAW_IMAGE_BYTES = 2_000_000;
export const AGENT_MAX_TURN_RAW_IMAGE_BYTES = 8_000_000;

/**
 * Exact standard base64 length for `n` raw bytes (includes padding).
 * Use `4 * ceil(n / 3)`, not `ceil(4n/3)` — the latter under-counts when n%3≠0.
 */
export function base64CharLengthForBytes(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return 0;
  }
  return 4 * Math.ceil(byteLength / 3);
}

/** Max base64 chars for one image at the raw-byte cap. */
export const AGENT_MAX_BASE64_CHARS_PER_IMAGE = base64CharLengthForBytes(
  AGENT_MAX_RAW_IMAGE_BYTES
);

/** Max total base64 chars for a full turn at the total raw-byte cap. */
export const AGENT_MAX_TURN_BASE64_CHARS = base64CharLengthForBytes(
  AGENT_MAX_TURN_RAW_IMAGE_BYTES
);
