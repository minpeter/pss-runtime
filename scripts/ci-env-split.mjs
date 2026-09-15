import { invokedExecutable } from "./ci-command-prefixes.mjs";

const BASENAME = /^.*\//;
const OPTIONS_WITH_VALUE = new Set(["-C", "--chdir", "-u", "--unset"]);

export function envSplitTokens(tokens, splitWords) {
  const env = tokens.findIndex(
    (token, index) =>
      token.replace(BASENAME, "") === "env" &&
      invokedExecutable([...tokens.slice(0, index), "__probe__"]) === index
  );
  if (env < 0) {
    return;
  }
  let option = env + 1;
  while (option < tokens.length) {
    const candidate = tokens[option];
    if (
      candidate === "-S" ||
      candidate === "--split-string" ||
      candidate.startsWith("-S") ||
      candidate.startsWith("--split-string=")
    ) {
      break;
    }
    if (!candidate.startsWith("-") || candidate === "--") {
      return;
    }
    option += OPTIONS_WITH_VALUE.has(candidate) ? 2 : 1;
  }
  if (option >= tokens.length) {
    return;
  }
  const token = tokens[option];
  const attached = token !== "-S" && token !== "--split-string";
  let value = tokens[option + 1];
  if (token.startsWith("--split-string=")) {
    value = token.slice("--split-string=".length);
  } else if (attached) {
    value = token.slice(2);
  }
  const words = splitWords((value ?? "").replaceAll("\\_", " "));
  return [...words, ...tokens.slice(option + (attached ? 1 : 2))];
}
