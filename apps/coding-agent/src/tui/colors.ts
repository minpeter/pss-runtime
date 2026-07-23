export const colors = {
  blue: "[94m",
  yellow: "[93m",
  green: "[92m",
  cyan: "[96m",
  red: "[91m",
  magenta: "[95m",
  white: "[97m",
  brightBlue: "[94m",
  brightGreen: "[92m",
  brightYellow: "[93m",
  brightCyan: "[96m",
  brightMagenta: "[95m",
  dim: "[2m",
  bold: "[1m",
  italic: "[3m",
  underline: "[4m",
  gray: "[90m",
  reset: "[0m",
} as const;

export function colorize(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`;
}
