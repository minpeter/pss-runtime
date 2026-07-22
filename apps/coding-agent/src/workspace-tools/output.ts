const DEFAULT_MAX_BYTES = 64 * 1024;

export function truncateToolOutput(
  value: string,
  maxBytes = DEFAULT_MAX_BYTES
): string {
  const bytes = Buffer.byteLength(value);
  if (bytes <= maxBytes) {
    return value;
  }
  const marker = `\n... truncated ${bytes - maxBytes} bytes ...\n`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  const headBudget = Math.floor(budget * 0.65);
  const tailBudget = budget - headBudget;
  const buffer = Buffer.from(value);
  return `${buffer.subarray(0, headBudget).toString()}${marker}${buffer.subarray(buffer.length - tailBudget).toString()}`;
}
