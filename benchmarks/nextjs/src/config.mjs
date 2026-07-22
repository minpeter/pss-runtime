import { DEFAULT_NEXT_VERSION } from "./constants.mjs";

const DEFAULT_STARTS_PER_MINUTE = 4;

function asSet(value) {
  // Blank values (e.g. an empty dotenv entry) count as unset so they cannot
  // bypass the pinned fallback.
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Resolution order: explicit CLI flag, then environment, then the pinned
 * default. Never resolves a moving registry tag so campaigns stay
 * reproducible by default.
 */
export function resolveNextVersion(
  requested,
  environment = process.env.PSS_BENCH_NEXT_VERSION
) {
  return asSet(requested) ?? asSet(environment) ?? DEFAULT_NEXT_VERSION;
}

export function resolveStartsPerMinute(
  raw = process.env.PSS_BENCH_STARTS_PER_MINUTE
) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_STARTS_PER_MINUTE;
}
