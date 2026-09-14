const ASSIGNMENT = /^\w+=/;
const BASENAME = /^.*\//;
const COMMAND_SEPARATOR = /[\n;&|]+/;
const CONTINUATION = /\\\r?\n[\t ]*/g;
const EMPTY_QUOTES = /""|''/g;
const ESCAPED_CHARACTER = /\\(.)/g;
const NPM_PUBLISH = /^pub(?:l(?:i(?:s(?:h)?)?)?)?$/;
const PNPM_PUBLISH = /^publish$/;
const SHELL_WORD = /(?:[^\s"'\\]+|"(?:\\.|[^"\\])*"|'[^']*'|\\.)+/g;

function words(command) {
  if (command.trimStart().startsWith("#")) {
    return [];
  }
  return (command.match(SHELL_WORD) ?? []).map((token) =>
    token.replace(EMPTY_QUOTES, "").replace(ESCAPED_CHARACTER, "$1")
  );
}

function packageCommand(tokens, executableName, commandPattern) {
  const executable = tokens.findIndex((token) => !ASSIGNMENT.test(token));
  if (tokens[executable]?.replace(BASENAME, "") !== executableName) {
    return false;
  }
  const command = tokens.findIndex(
    (token, index) => index > executable && commandPattern.test(token)
  );
  if (command < 0) {
    return false;
  }
  return tokens
    .slice(executable + 1, command)
    .every(
      (token, index) =>
        token.startsWith("-") || tokens[executable + index]?.startsWith("-")
    );
}

export function containsPublishCommand(source) {
  return source
    .replace(CONTINUATION, "")
    .split(COMMAND_SEPARATOR)
    .map(words)
    .some(
      (tokens) =>
        packageCommand(tokens, "npm", NPM_PUBLISH) ||
        packageCommand(tokens, "pnpm", PNPM_PUBLISH) ||
        tokens.join(" ") === "pnpm tegami ci"
    );
}
